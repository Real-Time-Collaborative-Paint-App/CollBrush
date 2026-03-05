"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { readStoredAccount, saveAccount } from "@/lib/account";
import type {
  BoardAction,
  BoardObject,
  BoardUser,
  CursorState,
  DrawMode,
  DrawSegment,
  FillAction,
  JoinBoardResponse,
  Point,
  ReplaceCanvasAction,
  TextStyle,
} from "@/lib/protocol";

type CollaborativeBoardProps = {
  boardId: string;
  userId: string;
  nickname: string;
};

type ToolMode = DrawMode | "bucket" | "select" | "drag" | "picker" | "text" | "sticky" | "zoom" | "shape";

type ShapeType =
  | "rectangle"
  | "ellipse"
  | "line"
  | "star"
  | "star-of-david"
  | "northern-star"
  | "arrow"
  | "double-arrow"
  | "heart";

type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SnapshotHistoryEntry = {
  before: string;
  after: string;
};

type ResizeSession = {
  startPoint: Point;
  startWidth: number;
  startHeight: number;
};

type RotateSession = {
  center: Point;
  startPointerAngle: number;
  startRotation: number;
};

type CreateObjectSession = {
  pointerId: number;
  mode: "text" | "sticky";
  startPoint: Point;
  currentPoint: Point;
};

type ShapeSession = {
  pointerId: number;
  startPoint: Point;
  currentPoint: Point;
  baseImage: ImageData;
  beforeSnapshot: string;
};

type SelectionTransformMode = "resize" | "rotate";

type SelectionTransformSession = {
  mode: SelectionTransformMode;
  startRect: SelectionRect;
  startPoint: Point;
  center: Point;
  startDistance: number;
  startAngle: number;
  baseImage: ImageData;
  selectionCanvas: HTMLCanvasElement;
  beforeSnapshot: string;
  affectedObjects: BoardObject[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: "Arial",
  fontSize: 24,
  color: "#111827",
  bold: false,
  italic: false,
  strikethrough: false,
  spoiler: false,
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const looksLikeHtml = (value: string) => /<\/?[a-z][\s\S]*>/i.test(value);

const toMarkupContent = (value: string) => {
  if (!value) {
    return "";
  }

  if (looksLikeHtml(value)) {
    return value;
  }

  return escapeHtml(value).replaceAll("\n", "<br>");
};

const normalizeBoardObject = (object: BoardObject): BoardObject => {
  if (object.type === "text") {
    return {
      ...object,
      width: object.width || 260,
      height: object.height || 120,
      rotation: object.rotation ?? 0,
      flipX: (object as { flipX?: boolean }).flipX ?? false,
      flipY: (object as { flipY?: boolean }).flipY ?? false,
      style: {
        ...DEFAULT_TEXT_STYLE,
        ...object.style,
      },
    };
  }

  return {
    ...object,
    width: object.width || 220,
    height: object.height || 160,
    rotation: object.rotation ?? 0,
    flipX: (object as { flipX?: boolean }).flipX ?? false,
    flipY: (object as { flipY?: boolean }).flipY ?? false,
    style: {
      ...DEFAULT_TEXT_STYLE,
      ...(object.style ?? {}),
      fontSize: object.style?.fontSize ?? 18,
    },
  };
};

const hexToRgba = (hexColor: string): [number, number, number, number] => {
  const hex = hexColor.replace("#", "").trim();
  if (hex.length !== 6) {
    return [17, 24, 39, 255];
  }

  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    255,
  ];
};

const toHex = (value: number) => value.toString(16).padStart(2, "0");

const rgbaToHex = (red: number, green: number, blue: number) =>
  `#${toHex(red)}${toHex(green)}${toHex(blue)}`;

const colorsEqual = (
  data: Uint8ClampedArray,
  index: number,
  color: [number, number, number, number],
) =>
  data[index] === color[0] &&
  data[index + 1] === color[1] &&
  data[index + 2] === color[2] &&
  data[index + 3] === color[3];

const normalizeRect = (from: Point, to: Point): SelectionRect => {
  const x1 = Math.floor(Math.min(from.x, to.x));
  const y1 = Math.floor(Math.min(from.y, to.y));
  const x2 = Math.floor(Math.max(from.x, to.x));
  const y2 = Math.floor(Math.max(from.y, to.y));

  return {
    x: x1,
    y: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
  };
};

const pointInRect = (point: Point, rect: SelectionRect) =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

const drawSegmentOnContext = (ctx: CanvasRenderingContext2D, segment: DrawSegment) => {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = segment.color;
  ctx.lineWidth = segment.size;
  ctx.globalCompositeOperation = segment.mode === "erase" ? "destination-out" : "source-over";

  ctx.beginPath();
  ctx.moveTo(segment.from.x, segment.from.y);
  ctx.lineTo(segment.to.x, segment.to.y);
  ctx.stroke();
  ctx.restore();
};

const applyFillToContext = (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  fill: FillAction,
) => {
  const startX = Math.floor(fill.point.x);
  const startY = Math.floor(fill.point.y);
  if (startX < 0 || startY < 0 || startX >= canvas.width || startY >= canvas.height) {
    return false;
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const targetIndex = (startY * canvas.width + startX) * 4;
  const target: [number, number, number, number] = [
    data[targetIndex],
    data[targetIndex + 1],
    data[targetIndex + 2],
    data[targetIndex + 3],
  ];
  const replacement = hexToRgba(fill.color);

  if (
    target[0] === replacement[0] &&
    target[1] === replacement[1] &&
    target[2] === replacement[2] &&
    target[3] === replacement[3]
  ) {
    return false;
  }

  const stack: number[] = [startX, startY];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;

    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
      continue;
    }

    const index = (y * canvas.width + x) * 4;
    if (!colorsEqual(data, index, target)) {
      continue;
    }

    data[index] = replacement[0];
    data[index + 1] = replacement[1];
    data[index + 2] = replacement[2];
    data[index + 3] = replacement[3];

    stack.push(x + 1, y);
    stack.push(x - 1, y);
    stack.push(x, y + 1);
    stack.push(x, y - 1);
  }

  ctx.putImageData(imageData, 0, 0);
  return true;
};

const drawReplaceOnContext = async (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  replace: ReplaceCanvasAction,
) => {
  await new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve();
    };
    image.onerror = () => resolve();
    image.src = replace.dataUrl;
  });
};

const drawShapeOutline = (
  ctx: CanvasRenderingContext2D,
  shape: ShapeType,
  from: Point,
  to: Point,
  strokeColor: string,
  strokeSize: number,
) => {
  const rect = normalizeRect(from, to);

  const drawPolygon = (points: Point[]) => {
    if (points.length < 2) {
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      ctx.lineTo(points[index].x, points[index].y);
    }
    ctx.closePath();
    ctx.stroke();
  };

  const createStarPoints = (arms: number, innerScale: number) => {
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const outerRadius = Math.max(2, Math.min(rect.width, rect.height) / 2);
    const innerRadius = outerRadius * innerScale;
    const points: Point[] = [];

    for (let index = 0; index < arms * 2; index += 1) {
      const angle = (-Math.PI / 2) + (index * Math.PI) / arms;
      const radius = index % 2 === 0 ? outerRadius : innerRadius;
      points.push({
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      });
    }

    return points;
  };

  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = clamp(strokeSize, 1, 40);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (shape === "rectangle") {
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    return;
  }

  if (shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      Math.max(1, rect.width / 2),
      Math.max(1, rect.height / 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (shape === "star") {
    drawPolygon(createStarPoints(5, 0.45));
    ctx.restore();
    return;
  }

  if (shape === "northern-star") {
    drawPolygon([
      { x: rect.x + rect.width * (12 / 24), y: rect.y + rect.height * (2 / 24) },
      { x: rect.x + rect.width * (14.5 / 24), y: rect.y + rect.height * (8.8 / 24) },
      { x: rect.x + rect.width * (22 / 24), y: rect.y + rect.height * (12 / 24) },
      { x: rect.x + rect.width * (14.5 / 24), y: rect.y + rect.height * (15.2 / 24) },
      { x: rect.x + rect.width * (12 / 24), y: rect.y + rect.height * (22 / 24) },
      { x: rect.x + rect.width * (9.5 / 24), y: rect.y + rect.height * (15.2 / 24) },
      { x: rect.x + rect.width * (2 / 24), y: rect.y + rect.height * (12 / 24) },
      { x: rect.x + rect.width * (9.5 / 24), y: rect.y + rect.height * (8.8 / 24) },
    ]);
    ctx.restore();
    return;
  }

  if (shape === "star-of-david") {
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const radius = Math.max(2, Math.min(rect.width, rect.height) / 2);
    const triangle = (offset: number) => {
      const points: Point[] = [];
      for (let index = 0; index < 3; index += 1) {
        const angle = offset + index * ((Math.PI * 2) / 3);
        points.push({
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
        });
      }
      return points;
    };

    drawPolygon(triangle(-Math.PI / 2));
    drawPolygon(triangle(Math.PI / 2));
    ctx.restore();
    return;
  }

  if (shape === "arrow") {
    drawPolygon([
      { x: rect.x, y: rect.y + rect.height * 0.35 },
      { x: rect.x + rect.width * 0.62, y: rect.y + rect.height * 0.35 },
      { x: rect.x + rect.width * 0.62, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
      { x: rect.x + rect.width * 0.62, y: rect.y + rect.height },
      { x: rect.x + rect.width * 0.62, y: rect.y + rect.height * 0.65 },
      { x: rect.x, y: rect.y + rect.height * 0.65 },
    ]);
    ctx.restore();
    return;
  }

  if (shape === "double-arrow") {
    drawPolygon([
      { x: rect.x, y: rect.y + rect.height / 2 },
      { x: rect.x + rect.width * 0.2, y: rect.y },
      { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.3 },
      { x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.3 },
      { x: rect.x + rect.width * 0.8, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
      { x: rect.x + rect.width * 0.8, y: rect.y + rect.height },
      { x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.7 },
      { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.7 },
      { x: rect.x + rect.width * 0.2, y: rect.y + rect.height },
    ]);
    ctx.restore();
    return;
  }

  if (shape === "heart") {
    const samples = 96;
    const rawPoints: Point[] = [];
    for (let index = 0; index <= samples; index += 1) {
      const t = (index / samples) * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = -(
        13 * Math.cos(t) -
        5 * Math.cos(2 * t) -
        2 * Math.cos(3 * t) -
        Math.cos(4 * t)
      );
      rawPoints.push({ x, y });
    }

    const minX = Math.min(...rawPoints.map((point) => point.x));
    const maxX = Math.max(...rawPoints.map((point) => point.x));
    const minY = Math.min(...rawPoints.map((point) => point.y));
    const maxY = Math.max(...rawPoints.map((point) => point.y));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

    const mappedPoints = rawPoints.map((point) => ({
      x: rect.x + ((point.x - minX) / width) * rect.width,
      y: rect.y + ((point.y - minY) / height) * rect.height,
    }));

    drawPolygon(mappedPoints);
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
};

export default function CollaborativeBoard({ boardId, userId, nickname }: CollaborativeBoardProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const actionsRef = useRef<BoardAction[]>([]);
  const lastCursorEmitRef = useRef(0);
  const lastSelectionPreviewEmitRef = useRef(0);
  const movingSelectionImageRef = useRef<ImageData | null>(null);
  const movingBaseImageRef = useRef<ImageData | null>(null);
  const remoteReplaceVersionRef = useRef(0);
  const undoStackRef = useRef<SnapshotHistoryEntry[]>([]);
  const redoStackRef = useRef<SnapshotHistoryEntry[]>([]);
  const strokeStartSnapshotRef = useRef<string | null>(null);
  const strokeChangedRef = useRef(false);
  const selectionMoveStartSnapshotRef = useRef<string | null>(null);
  const draggingObjectIdRef = useRef<string | null>(null);
  const objectDragOffsetRef = useRef<Point | null>(null);
  const lastObjectDragEmitRef = useRef(0);
  const resizingObjectIdRef = useRef<string | null>(null);
  const objectResizeSessionRef = useRef<ResizeSession | null>(null);
  const rotatingObjectIdRef = useRef<string | null>(null);
  const objectRotateSessionRef = useRef<RotateSession | null>(null);
  const objectCreateSessionRef = useRef<CreateObjectSession | null>(null);
  const shapeSessionRef = useRef<ShapeSession | null>(null);
  const shapeMenuRef = useRef<HTMLDivElement | null>(null);
  const shapeMenuContainerRef = useRef<HTMLDivElement | null>(null);
  const selectionTransformSessionRef = useRef<SelectionTransformSession | null>(null);
  const zoomHoldTimeoutRef = useRef<number | null>(null);
  const zoomHoldIntervalRef = useRef<number | null>(null);
  const editingElementRef = useRef<HTMLDivElement | null>(null);
  const activeToolbarRef = useRef<HTMLDivElement | null>(null);
  const selectedTextRangeRef = useRef<Range | null>(null);

  const isDrawingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const previousPointRef = useRef<Point | null>(null);
  const selectingRef = useRef(false);
  const movingRef = useRef(false);
  const selectionStartRef = useRef<Point | null>(null);
  const moveOffsetRef = useRef<Point | null>(null);

  const [usersCount, setUsersCount] = useState(1);
  const [boardUsers, setBoardUsers] = useState<BoardUser[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<Record<string, CursorState>>({});
  const [color, setColor] = useState("#111827");
  const [brushSize, setBrushSize] = useState(4);
  const [mode, setMode] = useState<ToolMode>("draw");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [selectionPreviewRect, setSelectionPreviewRect] = useState<SelectionRect | null>(null);
  const [selectionRotation, setSelectionRotation] = useState(0);
  const [selectionPreviewRotation, setSelectionPreviewRotation] = useState<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [boardObjects, setBoardObjects] = useState<Record<string, BoardObject>>({});
  const [activeObjectId, setActiveObjectId] = useState<string | null>(null);
  const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
  const [objectCreatePreview, setObjectCreatePreview] = useState<SelectionRect | null>(null);
  const [hoveredObjectId, setHoveredObjectId] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomOrigin, setZoomOrigin] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const [activeShape, setActiveShape] = useState<ShapeType>("rectangle");
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);

  const boardLink = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return `${window.location.origin}/board/${boardId}`;
  }, [boardId]);

  const getCanvasPoint = useCallback((event: PointerEvent | React.PointerEvent<Element>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }, []);

  const redrawFromActions = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const action of actionsRef.current) {
      if (action.type === "segment") {
        drawSegmentOnContext(ctx, action.segment);
      } else if (action.type === "fill") {
        applyFillToContext(ctx, canvas, action.fill);
      } else {
        await drawReplaceOnContext(ctx, canvas, action.replace);
      }
    }
  }, []);

  const resizeCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }

    const ratio = window.devicePixelRatio || 1;
    const nextWidth = Math.max(320, Math.floor(container.clientWidth * ratio));
    const nextHeight = Math.max(320, Math.floor(container.clientHeight * ratio));

    if (canvas.width === nextWidth && canvas.height === nextHeight) {
      return;
    }

    canvas.width = nextWidth;
    canvas.height = nextHeight;
    setCanvasSize({ width: nextWidth, height: nextHeight });
    void redrawFromActions();
  }, [redrawFromActions]);

  const applyBoardAction = useCallback((action: BoardAction, pushToState: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return false;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return false;
    }

    let applied = true;

    if (action.type === "segment") {
      drawSegmentOnContext(ctx, action.segment);
    } else if (action.type === "fill") {
      applied = applyFillToContext(ctx, canvas, action.fill);
    } else {
      applied = false;
    }

    if (pushToState && applied) {
      actionsRef.current.push(action);
    }

    return applied;
  }, []);

  const commitCanvasSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const replace: ReplaceCanvasAction = {
      dataUrl: canvas.toDataURL("image/png"),
    };

    actionsRef.current = [
      {
        type: "replace",
        replace,
      },
    ];

    socketRef.current?.emit("replace-canvas", replace);
  }, []);

  const emitSelectionMovePreview = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const now = Date.now();
    if (now - lastSelectionPreviewEmitRef.current < 40) {
      return;
    }

    socketRef.current?.emit("replace-canvas-preview", {
      dataUrl: canvas.toDataURL("image/png"),
    } satisfies ReplaceCanvasAction);
    lastSelectionPreviewEmitRef.current = now;
  }, []);

  const applyReplaceActionToCanvas = useCallback((replace: ReplaceCanvasAction) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    remoteReplaceVersionRef.current += 1;
    const currentVersion = remoteReplaceVersionRef.current;

    const image = new Image();
    image.onload = () => {
      if (currentVersion !== remoteReplaceVersionRef.current) {
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.src = replace.dataUrl;
  }, []);

  const getCanvasSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return "";
    }

    return canvas.toDataURL("image/png");
  }, []);

  const upsertBoardObject = useCallback((object: BoardObject, broadcast: boolean) => {
    const normalized = normalizeBoardObject(object);

    setBoardObjects((previous) => ({
      ...previous,
      [normalized.id]: normalized,
    }));

    if (broadcast) {
      socketRef.current?.emit("upsert-object", normalized);
    }
  }, []);

  const removeBoardObject = useCallback((id: string, broadcast: boolean) => {
    setBoardObjects((previous) => {
      if (!previous[id]) {
        return previous;
      }

      const next = { ...previous };
      delete next[id];
      return next;
    });

    if (broadcast) {
      socketRef.current?.emit("remove-object", { id });
    }
  }, []);

  const createObjectId = useCallback(
    () =>
      `obj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${
        (readStoredAccount()?.userId ?? "anon")
      }`,
    [],
  );

  const pushHistoryEntry = useCallback((entry: SnapshotHistoryEntry) => {
    if (!entry.before || !entry.after || entry.before === entry.after) {
      return;
    }

    undoStackRef.current.push(entry);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.splice(0, undoStackRef.current.length - 50);
    }

    redoStackRef.current = [];
  }, []);

  const applySnapshotAndBroadcast = useCallback(
    (dataUrl: string) => {
      if (!dataUrl) {
        return;
      }

      const replace: ReplaceCanvasAction = { dataUrl };
      actionsRef.current = [
        {
          type: "replace",
          replace,
        },
      ];
      setSelectionRect(null);
      setSelectionPreviewRect(null);
      setSelectionRotation(0);
      setSelectionPreviewRotation(null);
      movingBaseImageRef.current = null;
      movingSelectionImageRef.current = null;
      applyReplaceActionToCanvas(replace);
      socketRef.current?.emit("replace-canvas", replace);
    },
    [applyReplaceActionToCanvas],
  );

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    actionsRef.current = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setBoardObjects({});
    setSelectionRect(null);
    setSelectionPreviewRect(null);
    setSelectionRotation(0);
    setSelectionPreviewRotation(null);
    movingBaseImageRef.current = null;
    movingSelectionImageRef.current = null;
  }, []);

  useEffect(() => {
    resizeCanvas();

    const observer = new ResizeObserver(() => {
      resizeCanvas();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    window.addEventListener("resize", resizeCanvas);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [resizeCanvas]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const paramUserId = userId.trim().slice(0, 80);
    const paramNickname = nickname.trim().slice(0, 40);
    const stored = readStoredAccount();

    const nextUserId = paramUserId || stored?.userId || "";
    let nextNickname = paramNickname || stored?.nickname || "";

    if (!nextNickname) {
      nextNickname = window.prompt("Enter your nickname", "")?.trim().slice(0, 40) ?? "";
    }

    if (!nextNickname) {
      router.replace("/?error=login-required");
      return;
    }

    const account = saveAccount({
      userId: nextUserId,
      nickname: nextNickname,
    });

    const socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setIsConnected(true);

      socket.emit("join-board", { boardId, userId: account.userId, nickname: account.nickname }, (response: JoinBoardResponse) => {
        if (!response.ok) {
          if (response.code === "BOARD_FULL") {
            router.replace("/?error=board-full");
            return;
          }

          if (response.code === "INVALID_USER") {
            router.replace("/?error=login-required");
            return;
          }

          setJoinError(response.reason);
          return;
        }

        setJoinError(null);
        setUsersCount(response.usersCount);
        setBoardUsers(response.users);
        actionsRef.current = response.actions;
        setBoardObjects(
          Object.fromEntries(
            response.objects.map((object) => {
              const normalized = normalizeBoardObject(object);
              return [normalized.id, normalized];
            }),
          ) as Record<string, BoardObject>,
        );
        void redrawFromActions();
      });
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
    });

    socket.on("presence", ({ usersCount: nextUsersCount, users }: { usersCount: number; users: BoardUser[] }) => {
      setUsersCount(nextUsersCount);
      setBoardUsers(users);
      setRemoteCursors((previous) => {
        const onlineSocketIds = new Set(users.map((user) => user.socketId));
        const next: Record<string, CursorState> = {};
        for (const [socketId, cursorState] of Object.entries(previous)) {
          if (onlineSocketIds.has(socketId)) {
            next[socketId] = cursorState;
          }
        }

        return next;
      });
    });

    socket.on("draw-segment", (segment: DrawSegment) => {
      applyBoardAction(
        {
          type: "segment",
          segment,
        },
        true,
      );
    });

    socket.on("fill-area", (fill: FillAction) => {
      applyBoardAction(
        {
          type: "fill",
          fill,
        },
        true,
      );
    });

    socket.on("replace-canvas", (replace: ReplaceCanvasAction) => {
      actionsRef.current = [
        {
          type: "replace",
          replace,
        },
      ];
      setSelectionRect(null);
      setSelectionPreviewRect(null);
      setSelectionRotation(0);
      setSelectionPreviewRotation(null);
      movingBaseImageRef.current = null;
      movingSelectionImageRef.current = null;
      applyReplaceActionToCanvas(replace);
    });

    socket.on("replace-canvas-preview", (replace: ReplaceCanvasAction) => {
      applyReplaceActionToCanvas(replace);
    });

    socket.on("upsert-object", (object: BoardObject) => {
      upsertBoardObject(object, false);
    });

    socket.on("remove-object", ({ id }: { id: string }) => {
      removeBoardObject(id, false);
    });

    socket.on("cursor-move", (cursorState: CursorState) => {
      setRemoteCursors((previous) => ({
        ...previous,
        [cursorState.socketId]: cursorState,
      }));
    });

    socket.on("cursor-leave", ({ socketId }: { socketId: string }) => {
      setRemoteCursors((previous) => {
        if (!previous[socketId]) {
          return previous;
        }

        const next = { ...previous };
        delete next[socketId];
        return next;
      });
    });

    socket.on("clear-board", () => {
      handleClear();
    });

    return () => {
      socket.disconnect();
    };
  }, [
    applyBoardAction,
    applyReplaceActionToCanvas,
    boardId,
    handleClear,
    nickname,
    removeBoardObject,
    redrawFromActions,
    router,
    upsertBoardObject,
    userId,
  ]);

  const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (joinError) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    const clickedInsideSelection = selectionRect ? pointInRect(point, selectionRect) : false;
    if (selectionRect && !clickedInsideSelection && mode !== "select") {
      setSelectionRect(null);
      setSelectionPreviewRect(null);
      setSelectionRotation(0);
      setSelectionPreviewRotation(null);
      movingRef.current = false;
      moveOffsetRef.current = null;
      movingBaseImageRef.current = null;
      movingSelectionImageRef.current = null;
      selectionMoveStartSnapshotRef.current = null;
    }

    setActiveObjectId(null);
    setEditingObjectId(null);

    if (mode === "zoom") {
      const rect = canvas.getBoundingClientRect();
      let nextOrigin = zoomOrigin;
      if (rect.width > 0 && rect.height > 0) {
        const nextOriginX = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100);
        const nextOriginY = clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100);
        nextOrigin = { x: nextOriginX, y: nextOriginY };
        setZoomOrigin(nextOrigin);
      }

      pointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);

      clearZoomHold();
      const zoomDirection = event.button === 2 ? -1 : 1;
      const applyZoomStep = () => {
        setZoomOrigin(nextOrigin);
        setZoomLevel((previous) =>
          clamp(Number((previous + 0.25 * zoomDirection).toFixed(2)), 0.25, 4),
        );
      };

      applyZoomStep();
      zoomHoldTimeoutRef.current = window.setTimeout(() => {
        zoomHoldIntervalRef.current = window.setInterval(() => {
          applyZoomStep();
        }, 80);
      }, 200);

      return;
    }

    if (mode === "shape") {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      pointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      shapeSessionRef.current = {
        pointerId: event.pointerId,
        startPoint: point,
        currentPoint: point,
        baseImage: ctx.getImageData(0, 0, canvas.width, canvas.height),
        beforeSnapshot: getCanvasSnapshot(),
      };
      return;
    }

    if (mode === "text" || mode === "sticky") {
      pointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      objectCreateSessionRef.current = {
        pointerId: event.pointerId,
        mode,
        startPoint: point,
        currentPoint: point,
      };
      setObjectCreatePreview(normalizeRect(point, point));
      return;
    }

    if (mode === "picker") {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const x = Math.floor(point.x);
      const y = Math.floor(point.y);
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      setColor(rgbaToHex(pixel[0], pixel[1], pixel[2]));
      setMode("draw");
      return;
    }

    if (mode === "bucket") {
      const beforeSnapshot = getCanvasSnapshot();
      const fill: FillAction = {
        point,
        color,
      };

      const applied = applyBoardAction(
        {
          type: "fill",
          fill,
        },
        true,
      );

      if (applied) {
        socketRef.current?.emit("fill-area", fill);
        pushHistoryEntry({
          before: beforeSnapshot,
          after: getCanvasSnapshot(),
        });
      }

      return;
    }

    if (mode === "drag") {
      pointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);

      if (selectionRect && clickedInsideSelection && beginSelectionMove(canvas, point, selectionRect)) {
        return;
      }

      const connectedRegion = getConnectedOpaqueRegion(canvas, point);
      if (connectedRegion) {
        setSelectionRect(connectedRegion);
        setSelectionPreviewRect(connectedRegion);
        setSelectionRotation(0);
        setSelectionPreviewRotation(null);
        if (beginSelectionMove(canvas, point, connectedRegion)) {
          return;
        }
      }

      pointerIdRef.current = null;
      return;
    }

    if (mode === "select") {
      pointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);

      if (selectionRect && clickedInsideSelection && beginSelectionMove(canvas, point, selectionRect)) {
        selectingRef.current = false;
        return;
      }

      selectingRef.current = true;
      selectionStartRef.current = point;
      const nextRect = normalizeRect(point, point);
      setSelectionRect(nextRect);
      setSelectionPreviewRect(nextRect);
      setSelectionRotation(0);
      setSelectionPreviewRotation(null);
      return;
    }

    isDrawingRef.current = true;
    pointerIdRef.current = event.pointerId;
    previousPointRef.current = point;
    strokeStartSnapshotRef.current = canvas.toDataURL("image/png");
    strokeChangedRef.current = false;
    canvas.setPointerCapture(event.pointerId);
  };

  const continueDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const now = Date.now();
    if (now - lastCursorEmitRef.current >= 24) {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const normalizedX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
          const normalizedY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
          socketRef.current?.emit("cursor-move", {
            x: normalizedX,
            y: normalizedY,
          });
          lastCursorEmitRef.current = now;
        }
      }
    }

    const shapeSession = shapeSessionRef.current;
    if (mode === "shape" && shapeSession && pointerIdRef.current === event.pointerId) {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const ctx = canvas.getContext("2d");
      const point = getCanvasPoint(event);
      if (!ctx || !point) {
        return;
      }

      shapeSession.currentPoint = point;
      ctx.putImageData(shapeSession.baseImage, 0, 0);
      drawShapeOutline(ctx, activeShape, shapeSession.startPoint, shapeSession.currentPoint, color, brushSize);
      emitSelectionMovePreview();
      return;
    }

    if (mode === "select" || mode === "drag") {
      if (pointerIdRef.current !== event.pointerId) {
        return;
      }

      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }

      if (mode === "select" && selectingRef.current && selectionStartRef.current) {
        const nextRect = normalizeRect(selectionStartRef.current, point);
        setSelectionRect(nextRect);
        setSelectionPreviewRect(nextRect);
      } else if (movingRef.current && selectionRect && moveOffsetRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }

        const maxX = canvas.width - selectionRect.width;
        const maxY = canvas.height - selectionRect.height;
        const nextX = clamp(Math.floor(point.x - moveOffsetRef.current.x), 0, Math.max(0, maxX));
        const nextY = clamp(Math.floor(point.y - moveOffsetRef.current.y), 0, Math.max(0, maxY));
        const nextRect = {
          ...selectionRect,
          x: nextX,
          y: nextY,
        };
        setSelectionPreviewRect(nextRect);

        const ctx = canvas.getContext("2d");
        if (ctx && movingBaseImageRef.current && movingSelectionImageRef.current) {
          ctx.putImageData(movingBaseImageRef.current, 0, 0);
          ctx.putImageData(movingSelectionImageRef.current, nextRect.x, nextRect.y);
          emitSelectionMovePreview();
        }
      }

      return;
    }

    const createSession = objectCreateSessionRef.current;
    if (createSession) {
      if (pointerIdRef.current !== event.pointerId || createSession.pointerId !== event.pointerId) {
        return;
      }

      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }

      createSession.currentPoint = point;
      setObjectCreatePreview(normalizeRect(createSession.startPoint, point));
      return;
    }

    if (!isDrawingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }

    const currentPoint = getCanvasPoint(event);
    const previousPoint = previousPointRef.current;
    if (!currentPoint || !previousPoint) {
      return;
    }

    const segment: DrawSegment = {
      from: previousPoint,
      to: currentPoint,
      color: mode === "erase" ? "#000000" : color,
      size: clamp(brushSize, 1, 40),
      mode: mode === "erase" ? "erase" : "draw",
    };

    applyBoardAction(
      {
        type: "segment",
        segment,
      },
      true,
    );
    socketRef.current?.emit("draw-segment", segment);
    strokeChangedRef.current = true;

    previousPointRef.current = currentPoint;
  };

  const stopDrawing = (event?: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "zoom") {
      const canvas = canvasRef.current;
      if (event && canvas && pointerIdRef.current === event.pointerId) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      pointerIdRef.current = null;
      clearZoomHold();
      return;
    }

    const shapeSession = shapeSessionRef.current;
    if (shapeSession) {
      const canvas = canvasRef.current;
      if (event && pointerIdRef.current === event.pointerId) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.putImageData(shapeSession.baseImage, 0, 0);
          drawShapeOutline(
            ctx,
            activeShape,
            shapeSession.startPoint,
            shapeSession.currentPoint,
            color,
            brushSize,
          );
          commitCanvasSnapshot();
          pushHistoryEntry({
            before: shapeSession.beforeSnapshot,
            after: getCanvasSnapshot(),
          });
        }
      }

      shapeSessionRef.current = null;
      pointerIdRef.current = null;
      return;
    }

    const createSession = objectCreateSessionRef.current;
    if (createSession) {
      const canvas = canvasRef.current;
      if (event && pointerIdRef.current === event.pointerId) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const rect = normalizeRect(createSession.startPoint, createSession.currentPoint);
      const minWidth = createSession.mode === "text" ? 120 : 100;
      const minHeight = createSession.mode === "text" ? 56 : 72;

      const object: BoardObject =
        createSession.mode === "text"
          ? {
              id: createObjectId(),
              type: "text",
              x: Math.floor(rect.x),
              y: Math.floor(rect.y),
              width: clamp(rect.width, minWidth, Math.max(minWidth, canvas?.width ?? 1200)),
              height: clamp(rect.height, minHeight, Math.max(minHeight, canvas?.height ?? 900)),
              rotation: 0,
              flipX: false,
              flipY: false,
              content: "",
              style: { ...DEFAULT_TEXT_STYLE },
            }
          : {
              id: createObjectId(),
              type: "sticky",
              x: Math.floor(rect.x),
              y: Math.floor(rect.y),
              width: clamp(rect.width, minWidth, Math.max(minWidth, canvas?.width ?? 1200)),
              height: clamp(rect.height, minHeight, Math.max(minHeight, canvas?.height ?? 900)),
              rotation: 0,
              flipX: false,
              flipY: false,
              content: "",
              style: {
                ...DEFAULT_TEXT_STYLE,
                fontSize: 18,
              },
            };

      upsertBoardObject(object, true);
      setActiveObjectId(object.id);
      setEditingObjectId(object.id);
      setObjectCreatePreview(null);
      objectCreateSessionRef.current = null;
      pointerIdRef.current = null;

      if (createSession.mode === "sticky") {
        setMode("draw");
      }

      return;
    }

    if (mode === "select" || mode === "drag") {
      if (event && pointerIdRef.current === event.pointerId) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (selectingRef.current) {
        selectingRef.current = false;
        const rect = selectionPreviewRect;
        if (!rect || rect.width < 2 || rect.height < 2) {
          setSelectionRect(null);
          setSelectionPreviewRect(null);
          setSelectionRotation(0);
          setSelectionPreviewRotation(null);
        } else {
          setSelectionRect(rect);
          if (selectionPreviewRotation !== null) {
            setSelectionRotation(selectionPreviewRotation);
            setSelectionPreviewRotation(null);
          }
        }
      }

      if (movingRef.current) {
        movingRef.current = false;
        const target = selectionPreviewRect;
        if (target) {
          setSelectionRect(target);
          if (selectionPreviewRotation !== null) {
            setSelectionRotation(selectionPreviewRotation);
            setSelectionPreviewRotation(null);
          }
          commitCanvasSnapshot();
          pushHistoryEntry({
            before: selectionMoveStartSnapshotRef.current ?? "",
            after: getCanvasSnapshot(),
          });
        }

        selectionMoveStartSnapshotRef.current = null;
        movingBaseImageRef.current = null;
        movingSelectionImageRef.current = null;
      }

      pointerIdRef.current = null;
      selectionStartRef.current = null;
      moveOffsetRef.current = null;
      return;
    }

    if (event && pointerIdRef.current === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    isDrawingRef.current = false;
    pointerIdRef.current = null;
    previousPointRef.current = null;

    if (strokeChangedRef.current && strokeStartSnapshotRef.current) {
      pushHistoryEntry({
        before: strokeStartSnapshotRef.current,
        after: getCanvasSnapshot(),
      });
    }

    strokeChangedRef.current = false;
    strokeStartSnapshotRef.current = null;
  };

  const clearBoard = () => {
    const beforeSnapshot = getCanvasSnapshot();
    handleClear();
    socketRef.current?.emit("clear-board");
    pushHistoryEntry({
      before: beforeSnapshot,
      after: getCanvasSnapshot(),
    });
  };

  const emitCursorOnEnter = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const normalizedX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const normalizedY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    socketRef.current?.emit("cursor-move", {
      x: normalizedX,
      y: normalizedY,
    });
  };

  const beginSelectionMove = (
    canvas: HTMLCanvasElement,
    point: Point,
    rect: SelectionRect,
  ) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return false;
    }

    movingRef.current = true;
    moveOffsetRef.current = {
      x: point.x - rect.x,
      y: point.y - rect.y,
    };

    const fullImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const baseData = new Uint8ClampedArray(fullImage.data);
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        baseData[index] = 0;
        baseData[index + 1] = 0;
        baseData[index + 2] = 0;
        baseData[index + 3] = 0;
      }
    }

    movingBaseImageRef.current = new ImageData(baseData, canvas.width, canvas.height);
    movingSelectionImageRef.current = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    selectionMoveStartSnapshotRef.current = canvas.toDataURL("image/png");
    setSelectionPreviewRect(rect);
    return true;
  };

  const getConnectedOpaqueRegion = (
    canvas: HTMLCanvasElement,
    point: Point,
  ): SelectionRect | null => {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    const x = clamp(Math.floor(point.x), 0, canvas.width - 1);
    const y = clamp(Math.floor(point.y), 0, canvas.height - 1);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;

    const alphaAt = (cx: number, cy: number) => data[(cy * width + cx) * 4 + 3];
    if (alphaAt(x, y) === 0) {
      return null;
    }

    const visited = new Uint8Array(width * height);
    const stack: number[] = [x, y];
    let minX = x;
    let maxX = x;
    let minY = y;
    let maxY = y;

    while (stack.length > 0) {
      const cy = stack.pop() as number;
      const cx = stack.pop() as number;

      if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
        continue;
      }

      const index = cy * width + cx;
      if (visited[index]) {
        continue;
      }
      visited[index] = 1;

      if (alphaAt(cx, cy) === 0) {
        continue;
      }

      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);

      stack.push(cx + 1, cy);
      stack.push(cx - 1, cy);
      stack.push(cx, cy + 1);
      stack.push(cx, cy - 1);
    }

    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX + 1),
      height: Math.max(1, maxY - minY + 1),
    };
  };

  const clearZoomHold = useCallback(() => {
    if (zoomHoldTimeoutRef.current !== null) {
      window.clearTimeout(zoomHoldTimeoutRef.current);
      zoomHoldTimeoutRef.current = null;
    }

    if (zoomHoldIntervalRef.current !== null) {
      window.clearInterval(zoomHoldIntervalRef.current);
      zoomHoldIntervalRef.current = null;
    }
  }, []);

  const rectIntersectsObject = (rect: SelectionRect, object: BoardObject) => {
    const objectRight = object.x + object.width;
    const objectBottom = object.y + object.height;
    const rectRight = rect.x + rect.width;
    const rectBottom = rect.y + rect.height;

    return !(objectRight < rect.x || object.x > rectRight || objectBottom < rect.y || object.y > rectBottom);
  };

  const flipSelectionObjects = (axis: "horizontal" | "vertical", rect: SelectionRect) => {
    const objects = Object.values(boardObjects).filter(
      (object) => rectIntersectsObject(rect, object) || object.id === activeObjectId,
    );
    for (const object of objects) {
      const nextObject: BoardObject =
        axis === "horizontal"
          ? {
              ...object,
              x: Math.floor(rect.x + rect.width - (object.x - rect.x) - object.width),
              flipX: !object.flipX,
            }
          : {
              ...object,
              y: Math.floor(rect.y + rect.height - (object.y - rect.y) - object.height),
              flipY: !object.flipY,
            };

      upsertBoardObject(nextObject, true);
    }
  };

  const flipSelectionPixels = (axis: "horizontal" | "vertical") => {
    const rect = selectionRect;
    const canvas = canvasRef.current;
    if (!rect || !canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const beforeSnapshot = getCanvasSnapshot();
    const imageData = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = rect.width;
    tempCanvas.height = rect.height;
    const tempCtx = tempCanvas.getContext("2d");
    if (!tempCtx) {
      return;
    }

    tempCtx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    if (axis === "horizontal") {
      ctx.translate(rect.x + rect.width, rect.y);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(rect.x, rect.y + rect.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.restore();

    flipSelectionObjects(axis, rect);
    commitCanvasSnapshot();
    pushHistoryEntry({
      before: beforeSnapshot,
      after: getCanvasSnapshot(),
    });
  };

  const getSelectionTransformBounds = (
    center: Point,
    width: number,
    height: number,
    angle: number,
  ): SelectionRect => {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const corners = [
      { x: -halfWidth, y: -halfHeight },
      { x: halfWidth, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
      { x: -halfWidth, y: halfHeight },
    ].map((corner) => ({
      x: center.x + corner.x * Math.cos(angle) - corner.y * Math.sin(angle),
      y: center.y + corner.x * Math.sin(angle) + corner.y * Math.cos(angle),
    }));

    const minX = Math.min(...corners.map((corner) => corner.x));
    const maxX = Math.max(...corners.map((corner) => corner.x));
    const minY = Math.min(...corners.map((corner) => corner.y));
    const maxY = Math.max(...corners.map((corner) => corner.y));

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.max(1, Math.ceil(maxX - minX)),
      height: Math.max(1, Math.ceil(maxY - minY)),
    };
  };

  const beginSelectionTransform = (
    mode: SelectionTransformMode,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    event.preventDefault();

    const rect = selectionRect;
    const canvas = canvasRef.current;
    if (!rect || !canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    const point = getCanvasPoint(event);
    if (!ctx || !point) {
      return;
    }

    const center = {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
    const startDistance = Math.max(
      8,
      Math.hypot(point.x - center.x, point.y - center.y),
    );
    const startAngle = Math.atan2(point.y - center.y, point.x - center.x);

    const selectionImage = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    const fullImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const baseData = new Uint8ClampedArray(fullImage.data);
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        baseData[index] = 0;
        baseData[index + 1] = 0;
        baseData[index + 2] = 0;
        baseData[index + 3] = 0;
      }
    }

    const selectionCanvas = document.createElement("canvas");
    selectionCanvas.width = rect.width;
    selectionCanvas.height = rect.height;
    const selectionCtx = selectionCanvas.getContext("2d");
    if (!selectionCtx) {
      return;
    }
    selectionCtx.putImageData(selectionImage, 0, 0);

    const affectedObjects = Object.values(boardObjects).filter(
      (object) => rectIntersectsObject(rect, object) || object.id === activeObjectId,
    );

    selectionTransformSessionRef.current = {
      mode,
      startRect: rect,
      startPoint: point,
      center,
      startDistance,
      startAngle,
      baseImage: new ImageData(baseData, canvas.width, canvas.height),
      selectionCanvas,
      beforeSnapshot: getCanvasSnapshot(),
      affectedObjects,
    };

    setSelectionPreviewRotation(selectionRotation);

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateSelectionTransform = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = selectionTransformSessionRef.current;
    const canvas = canvasRef.current;
    if (!session || !canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    const point = getCanvasPoint(event);
    if (!ctx || !point) {
      return;
    }

    const angleDelta =
      session.mode === "rotate"
        ? Math.atan2(point.y - session.center.y, point.x - session.center.x) - session.startAngle
        : 0;

    const scaleFactor =
      session.mode === "resize"
        ? clamp(
            Math.hypot(point.x - session.center.x, point.y - session.center.y) /
              Math.max(1, session.startDistance),
            0.1,
            8,
          )
        : 1;

    ctx.putImageData(session.baseImage, 0, 0);
    ctx.save();
    ctx.translate(session.center.x, session.center.y);
    ctx.rotate(angleDelta);
    ctx.scale(scaleFactor, scaleFactor);
    ctx.drawImage(
      session.selectionCanvas,
      -session.startRect.width / 2,
      -session.startRect.height / 2,
      session.startRect.width,
      session.startRect.height,
    );
    ctx.restore();

    const nextRect =
      session.mode === "rotate"
        ? session.startRect
        : getSelectionTransformBounds(
            session.center,
            session.startRect.width * scaleFactor,
            session.startRect.height * scaleFactor,
            angleDelta,
          );
    setSelectionPreviewRect(nextRect);
    const nextRotation = (selectionRotation + (angleDelta * 180) / Math.PI + 3600) % 360;
    setSelectionPreviewRotation(nextRotation);

    const angleDeg = (angleDelta * 180) / Math.PI;
    const transformedObjects: BoardObject[] = [];
    for (const startObject of session.affectedObjects) {
      const objectCenterX = startObject.x + startObject.width / 2;
      const objectCenterY = startObject.y + startObject.height / 2;
      const offsetX = objectCenterX - session.center.x;
      const offsetY = objectCenterY - session.center.y;

      const scaledOffsetX = offsetX * scaleFactor;
      const scaledOffsetY = offsetY * scaleFactor;

      const rotatedCenterX =
        session.center.x + scaledOffsetX * Math.cos(angleDelta) - scaledOffsetY * Math.sin(angleDelta);
      const rotatedCenterY =
        session.center.y + scaledOffsetX * Math.sin(angleDelta) + scaledOffsetY * Math.cos(angleDelta);

      const nextWidth = clamp(Math.floor(startObject.width * scaleFactor), 40, 1400);
      const nextHeight = clamp(Math.floor(startObject.height * scaleFactor), 24, 1200);

      const nextObject: BoardObject = {
        ...startObject,
        x: Math.floor(rotatedCenterX - nextWidth / 2),
        y: Math.floor(rotatedCenterY - nextHeight / 2),
        width: nextWidth,
        height: nextHeight,
        rotation: (startObject.rotation + angleDeg + 3600) % 360,
      };

      upsertBoardObject(nextObject, false);
      transformedObjects.push(nextObject);
    }

    emitSelectionMovePreview();

    const now = Date.now();
    if (now - lastObjectDragEmitRef.current >= 24) {
      for (const transformedObject of transformedObjects) {
        socketRef.current?.emit("upsert-object", transformedObject);
      }
      lastObjectDragEmitRef.current = now;
    }
  };

  const finishSelectionTransform = (event: React.PointerEvent<HTMLButtonElement>) => {
    const session = selectionTransformSessionRef.current;
    if (!session) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);

    const finalRect =
      session.mode === "rotate" ? session.startRect : (selectionPreviewRect ?? session.startRect);
    setSelectionRect(finalRect);
    setSelectionPreviewRect(finalRect);
    setSelectionRotation(selectionPreviewRotation ?? selectionRotation);
    setSelectionPreviewRotation(null);

    for (const startObject of session.affectedObjects) {
      const latestObject = boardObjects[startObject.id];
      if (latestObject) {
        upsertBoardObject(latestObject, true);
      }
    }

    commitCanvasSnapshot();
    pushHistoryEntry({
      before: session.beforeSnapshot,
      after: getCanvasSnapshot(),
    });

    selectionTransformSessionRef.current = null;
  };

  const startSelectionDragFromHandle = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();

    const rect = selectionRect;
    const canvas = canvasRef.current;
    const point = getCanvasPoint(event);
    if (!rect || !canvas || !point) {
      return;
    }

    pointerIdRef.current = event.pointerId;
    if (beginSelectionMove(canvas, point, rect)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const updateSelectionDragFromHandle = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!movingRef.current || pointerIdRef.current !== event.pointerId || !selectionRect || !moveOffsetRef.current) {
      return;
    }

    const point = getCanvasPoint(event);
    const canvas = canvasRef.current;
    if (!point || !canvas) {
      return;
    }

    const maxX = canvas.width - selectionRect.width;
    const maxY = canvas.height - selectionRect.height;
    const nextX = clamp(Math.floor(point.x - moveOffsetRef.current.x), 0, Math.max(0, maxX));
    const nextY = clamp(Math.floor(point.y - moveOffsetRef.current.y), 0, Math.max(0, maxY));
    const nextRect = {
      ...selectionRect,
      x: nextX,
      y: nextY,
    };
    setSelectionPreviewRect(nextRect);

    const ctx = canvas.getContext("2d");
    if (ctx && movingBaseImageRef.current && movingSelectionImageRef.current) {
      ctx.putImageData(movingBaseImageRef.current, 0, 0);
      ctx.putImageData(movingSelectionImageRef.current, nextRect.x, nextRect.y);
      emitSelectionMovePreview();
    }
  };

  const finishSelectionDragFromHandle = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);

    if (movingRef.current) {
      movingRef.current = false;
      const target = selectionPreviewRect;
      if (target) {
        setSelectionRect(target);
        if (selectionPreviewRotation !== null) {
          setSelectionRotation(selectionPreviewRotation);
          setSelectionPreviewRotation(null);
        }
        commitCanvasSnapshot();
        pushHistoryEntry({
          before: selectionMoveStartSnapshotRef.current ?? "",
          after: getCanvasSnapshot(),
        });
      }

      selectionMoveStartSnapshotRef.current = null;
      movingBaseImageRef.current = null;
      movingSelectionImageRef.current = null;
    }

    pointerIdRef.current = null;
    moveOffsetRef.current = null;
  };

  const onObjectPointerDown = (event: React.PointerEvent<HTMLDivElement>, object: BoardObject) => {
    event.stopPropagation();

    setActiveObjectId(object.id);

    if (editingObjectId === object.id) {
      if (mode === "drag" || mode === "select") {
        setEditingObjectId(null);
      } else {
        return;
      }
    }

    const canDragInCurrentMode =
      mode === "drag" ||
      mode === "select" ||
      (mode === "text" && object.type === "text") ||
      (mode === "sticky" && object.type === "sticky");

    if (!canDragInCurrentMode) {
      return;
    }

    event.preventDefault();

    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    draggingObjectIdRef.current = object.id;
    objectDragOffsetRef.current = {
      x: point.x - object.x,
      y: point.y - object.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onObjectPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rotatingObjectId = rotatingObjectIdRef.current;
    const rotateSession = objectRotateSessionRef.current;
    if (rotatingObjectId && rotateSession) {
      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }

      const currentObject = boardObjects[rotatingObjectId];
      if (!currentObject) {
        return;
      }

      const currentAngle = Math.atan2(point.y - rotateSession.center.y, point.x - rotateSession.center.x);
      const nextRotation = ((rotateSession.startRotation + (currentAngle - rotateSession.startPointerAngle)) * 180) / Math.PI;

      const nextObject: BoardObject = {
        ...currentObject,
        rotation: Math.round(nextRotation),
      };

      upsertBoardObject(nextObject, false);

      const now = Date.now();
      if (now - lastObjectDragEmitRef.current >= 24) {
        socketRef.current?.emit("upsert-object", nextObject);
        lastObjectDragEmitRef.current = now;
      }

      return;
    }

    const resizingObjectId = resizingObjectIdRef.current;
    const resizeSession = objectResizeSessionRef.current;
    if (resizingObjectId && resizeSession) {
      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }

      const currentObject = boardObjects[resizingObjectId];
      if (!currentObject) {
        return;
      }

      const deltaX = point.x - resizeSession.startPoint.x;
      const deltaY = point.y - resizeSession.startPoint.y;
      const nextObject: BoardObject = {
        ...currentObject,
        width: clamp(Math.floor(resizeSession.startWidth + deltaX), 60, 1200),
        height: clamp(Math.floor(resizeSession.startHeight + deltaY), 40, 1000),
      };

      upsertBoardObject(nextObject, false);

      const now = Date.now();
      if (now - lastObjectDragEmitRef.current >= 24) {
        socketRef.current?.emit("upsert-object", nextObject);
        lastObjectDragEmitRef.current = now;
      }

      return;
    }

    const objectId = draggingObjectIdRef.current;
    const dragOffset = objectDragOffsetRef.current;
    if (!objectId || !dragOffset) {
      return;
    }

    const point = getCanvasPoint(event);
    const canvas = canvasRef.current;
    if (!point || !canvas) {
      return;
    }

    const currentObject = boardObjects[objectId];
    if (!currentObject) {
      return;
    }

    const nextX = clamp(Math.floor(point.x - dragOffset.x), 0, canvas.width - 8);
    const nextY = clamp(Math.floor(point.y - dragOffset.y), 0, canvas.height - 8);

    const nextObject: BoardObject = {
      ...currentObject,
      x: nextX,
      y: nextY,
    };

    upsertBoardObject(nextObject, false);

    const now = Date.now();
    if (now - lastObjectDragEmitRef.current >= 24) {
      socketRef.current?.emit("upsert-object", nextObject);
      lastObjectDragEmitRef.current = now;
    }
  };

  const onObjectPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const rotatingObjectId = rotatingObjectIdRef.current;
    if (rotatingObjectId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      const object = boardObjects[rotatingObjectId];
      if (object) {
        socketRef.current?.emit("upsert-object", object);
      }

      rotatingObjectIdRef.current = null;
      objectRotateSessionRef.current = null;
      return;
    }

    const resizingObjectId = resizingObjectIdRef.current;
    if (resizingObjectId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      const object = boardObjects[resizingObjectId];
      if (object) {
        socketRef.current?.emit("upsert-object", object);
      }

      resizingObjectIdRef.current = null;
      objectResizeSessionRef.current = null;
      return;
    }

    const objectId = draggingObjectIdRef.current;
    const dragOffset = objectDragOffsetRef.current;
    if (!objectId) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);

    const point = getCanvasPoint(event);
    const canvas = canvasRef.current;
    const currentObject = boardObjects[objectId];
    if (point && canvas && dragOffset && currentObject) {
      const nextObject: BoardObject = {
        ...currentObject,
        x: clamp(Math.floor(point.x - dragOffset.x), 0, canvas.width - 8),
        y: clamp(Math.floor(point.y - dragOffset.y), 0, canvas.height - 8),
      };

      upsertBoardObject(nextObject, true);
    } else if (currentObject) {
      socketRef.current?.emit("upsert-object", currentObject);
    }

    draggingObjectIdRef.current = null;
    objectDragOffsetRef.current = null;
  };

  const onObjectResizePointerDown = (event: React.PointerEvent<HTMLButtonElement>, object: BoardObject) => {
    event.stopPropagation();
    event.preventDefault();

    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    resizingObjectIdRef.current = object.id;
    objectResizeSessionRef.current = {
      startPoint: point,
      startWidth: object.width,
      startHeight: object.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onObjectRotatePointerDown = (event: React.PointerEvent<HTMLButtonElement>, object: BoardObject) => {
    event.stopPropagation();
    event.preventDefault();

    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    const center = {
      x: object.x + object.width / 2,
      y: object.y + object.height / 2,
    };

    rotatingObjectIdRef.current = object.id;
    objectRotateSessionRef.current = {
      center,
      startPointerAngle: Math.atan2(point.y - center.y, point.x - center.x),
      startRotation: ((object.rotation ?? 0) * Math.PI) / 180,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onObjectDragHandlePointerDown = (event: React.PointerEvent<HTMLButtonElement>, object: BoardObject) => {
    event.stopPropagation();
    event.preventDefault();

    setActiveObjectId(object.id);

    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }

    draggingObjectIdRef.current = object.id;
    objectDragOffsetRef.current = {
      x: point.x - object.x,
      y: point.y - object.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onObjectDoubleClick = (object: BoardObject) => {
    setActiveObjectId(object.id);
    setEditingObjectId(object.id);
  };

  const onObjectContentChange = (objectId: string, value: string) => {
    const object = boardObjects[objectId];
    if (!object) {
      return;
    }

    const nextObject: BoardObject = {
      ...object,
      content: value,
    };

    upsertBoardObject(nextObject, false);
    socketRef.current?.emit("upsert-object", nextObject);
  };

  const applyStyleToSelectedText = (patch: Partial<TextStyle>) => {
    const objectId = editingObjectId;
    const editor = editingElementRef.current;
    if (!objectId || !editor) {
      return false;
    }

    const selection = window.getSelection();
    let range: Range | null = null;
    if (selection && selection.rangeCount > 0) {
      const directRange = selection.getRangeAt(0);
      if (!directRange.collapsed && editor.contains(directRange.commonAncestorContainer)) {
        range = directRange.cloneRange();
      }
    }

    if (!range) {
      const savedRange = selectedTextRangeRef.current;
      if (savedRange && !savedRange.collapsed && editor.contains(savedRange.commonAncestorContainer)) {
        range = savedRange.cloneRange();
      }
    }

    if (!range) {
      return false;
    }

    const fragment = range.extractContents();
    const baseSpan = document.createElement("span");

    if (patch.fontFamily) {
      baseSpan.style.fontFamily = patch.fontFamily;
    }

    if (typeof patch.fontSize === "number") {
      baseSpan.style.fontSize = `${patch.fontSize}px`;
    }

    if (patch.color) {
      baseSpan.style.color = patch.color;
    }

    if (typeof patch.bold === "boolean") {
      baseSpan.style.fontWeight = patch.bold ? "700" : "400";
    }

    if (typeof patch.italic === "boolean") {
      baseSpan.style.fontStyle = patch.italic ? "italic" : "normal";
    }

    if (typeof patch.strikethrough === "boolean") {
      baseSpan.style.textDecoration = patch.strikethrough ? "line-through" : "none";
    }

    baseSpan.appendChild(fragment);
    range.insertNode(baseSpan);

    if (patch.spoiler) {
      const applySpoilerToTextNodes = (root: Node) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNodes: Text[] = [];
        let current = walker.nextNode();
        while (current) {
          if (current.nodeType === Node.TEXT_NODE && current.nodeValue?.trim()) {
            textNodes.push(current as Text);
          }
          current = walker.nextNode();
        }

        for (const textNode of textNodes) {
          const parent = textNode.parentElement;
          if (parent?.classList.contains("cb-inline-spoiler")) {
            continue;
          }

          const spoilerSpan = document.createElement("span");
          spoilerSpan.className = "cb-inline-spoiler";
          spoilerSpan.dataset.inlineSpoiler = "true";
          spoilerSpan.style.backgroundColor = "rgba(0,0,0,0.18)";
          spoilerSpan.style.borderRadius = "2px";
          parent?.insertBefore(spoilerSpan, textNode);
          spoilerSpan.appendChild(textNode);
        }
      };

      applySpoilerToTextNodes(baseSpan);
    }

    const caretRange = document.createRange();
    caretRange.setStartAfter(baseSpan);
    caretRange.collapse(true);
    selectedTextRangeRef.current = null;

    if (selection) {
      selection.removeAllRanges();
      selection.addRange(caretRange);
    }

    onObjectContentChange(objectId, editor.innerHTML);
    return true;
  };

  const updateActiveObjectStyle = (patch: Partial<TextStyle>) => {
    if (!activeObjectId) {
      return;
    }

    const object = boardObjects[activeObjectId];
    if (!object) {
      return;
    }

    const nextObject: BoardObject = {
      ...object,
      style: {
        ...object.style,
        ...patch,
      },
    };

    upsertBoardObject(nextObject, true);
  };

  const updateFontFamily = (fontFamily: string) => {
    if (applyStyleToSelectedText({ fontFamily })) {
      return;
    }

    updateActiveObjectStyle({ fontFamily });
  };

  const updateFontSize = (fontSize: number) => {
    const normalizedSize = clamp(fontSize || 8, 8, 120);
    if (applyStyleToSelectedText({ fontSize: normalizedSize })) {
      return;
    }

    updateActiveObjectStyle({ fontSize: normalizedSize });
  };

  const updateFontColor = (nextColor: string) => {
    if (applyStyleToSelectedText({ color: nextColor })) {
      return;
    }

    updateActiveObjectStyle({ color: nextColor });
  };

  const updateTextStyleFlag = (key: keyof Pick<TextStyle, "bold" | "italic" | "strikethrough" | "spoiler">) => {
    if (!activeObjectId) {
      return;
    }

    const object = boardObjects[activeObjectId];
    if (!object) {
      return;
    }

    if (key === "spoiler") {
      const applied = applyStyleToSelectedText({ spoiler: true });
      if (!applied) {
        return;
      }
      return;
    }

    const nextValue = !object.style[key];
    if (applyStyleToSelectedText({ [key]: nextValue })) {
      return;
    }

    updateActiveObjectStyle({ [key]: nextValue });
  };

  const finishObjectEditing = (event?: React.FocusEvent<HTMLElement>) => {
    const nextFocusedNode = event?.relatedTarget as Node | null;
    if (nextFocusedNode && activeToolbarRef.current?.contains(nextFocusedNode)) {
      return;
    }

    const editingId = editingObjectId;
    if (!editingId) {
      return;
    }

    if (editingElementRef.current) {
      onObjectContentChange(editingId, editingElementRef.current.innerHTML);
    }

    const object = boardObjects[editingId];
    if (object) {
      socketRef.current?.emit("upsert-object", object);
    }

    if (editingElementRef.current) {
      delete editingElementRef.current.dataset.editingObjectId;
    }

    selectedTextRangeRef.current = null;

    setEditingObjectId(null);
  };

  useEffect(() => {
    if (!editingObjectId) {
      return;
    }

    const object = boardObjects[editingObjectId];
    const editor = editingElementRef.current;
    if (!object || !editor) {
      return;
    }

    if (editor.dataset.editingObjectId === editingObjectId) {
      return;
    }

    editor.innerHTML = toMarkupContent(object.content);
    editor.dataset.editingObjectId = editingObjectId;
  }, [boardObjects, editingObjectId]);

  useEffect(() => {
    const onSelectionChange = () => {
      const editor = editingElementRef.current;
      if (!editor) {
        selectedTextRangeRef.current = null;
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      if (!range.collapsed && editor.contains(range.commonAncestorContainer)) {
        selectedTextRangeRef.current = range.cloneRange();
      }
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  useEffect(() => () => {
    clearZoomHold();
  }, [clearZoomHold]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!shapeMenuOpen) {
        return;
      }

      const container = shapeMenuContainerRef.current;
      const target = event.target as Node | null;
      if (!container || !target) {
        return;
      }

      if (!container.contains(target)) {
        setShapeMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [shapeMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMode("drag");
        event.preventDefault();
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      const lowerKey = event.key.toLowerCase();

      if (!isCtrlOrMeta) {
        if (lowerKey === "q") {
          setMode("draw");
          event.preventDefault();
          return;
        }

        if (lowerKey === "s") {
          setMode("select");
          event.preventDefault();
          return;
        }

        if (lowerKey === "d") {
          setMode("drag");
          event.preventDefault();
          return;
        }

        if (lowerKey === "e") {
          setMode("erase");
          event.preventDefault();
          return;
        }

        if (lowerKey === "b") {
          setMode("bucket");
          event.preventDefault();
          return;
        }

        if (lowerKey === "p") {
          setMode("picker");
          event.preventDefault();
          return;
        }

        if (lowerKey === "t") {
          setMode("text");
          event.preventDefault();
          return;
        }

        if (lowerKey === "n") {
          setMode("sticky");
          event.preventDefault();
          return;
        }

        if (lowerKey === "c") {
          setMode("shape");
          event.preventDefault();
          return;
        }

        if (lowerKey === "g") {
          setMode("zoom");
          event.preventDefault();
          return;
        }
      }

      if (isCtrlOrMeta && lowerKey === "z" && !event.shiftKey) {
        const last = undoStackRef.current.pop();
        if (!last) {
          return;
        }

        redoStackRef.current.push(last);
        applySnapshotAndBroadcast(last.before);
        event.preventDefault();
        return;
      }

      if (isCtrlOrMeta && (lowerKey === "y" || (lowerKey === "z" && event.shiftKey))) {
        const last = redoStackRef.current.pop();
        if (!last) {
          return;
        }

        undoStackRef.current.push(last);
        applySnapshotAndBroadcast(last.after);
        event.preventDefault();
        return;
      }

      if ((event.key !== "Delete" && event.key !== "Backspace") || !selectionRect) {
        if ((event.key === "Delete" || event.key === "Backspace") && activeObjectId) {
          removeBoardObject(activeObjectId, true);
          if (editingObjectId === activeObjectId) {
            setEditingObjectId(null);
          }
          setActiveObjectId(null);
          event.preventDefault();
        }
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const beforeSnapshot = getCanvasSnapshot();
      ctx.clearRect(selectionRect.x, selectionRect.y, selectionRect.width, selectionRect.height);
      setSelectionRect(null);
      setSelectionPreviewRect(null);
      setSelectionRotation(0);
      setSelectionPreviewRotation(null);
      commitCanvasSnapshot();
      pushHistoryEntry({
        before: beforeSnapshot,
        after: getCanvasSnapshot(),
      });
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    applySnapshotAndBroadcast,
    activeObjectId,
    commitCanvasSnapshot,
    editingObjectId,
    getCanvasSnapshot,
    pushHistoryEntry,
    removeBoardObject,
    selectionRect,
  ]);

  const displayedSelection = selectionPreviewRect ?? selectionRect;
  const displayedSelectionRotation = selectionPreviewRotation ?? selectionRotation;
  const shapeOptions: Array<{ value: ShapeType; label: string }> = [
    { value: "rectangle", label: "Rectangle" },
    { value: "ellipse", label: "Ellipse" },
    { value: "heart", label: "Heart" },
    { value: "line", label: "Line" },
    { value: "star", label: "Star" },
    { value: "star-of-david", label: "Star of David" },
    { value: "northern-star", label: "Northern Star" },
    { value: "arrow", label: "Arrow" },
    { value: "double-arrow", label: "Double Arrow" },
  ];
  const activeShapeLabel = shapeOptions.find((option) => option.value === activeShape)?.label ?? "Shape";

  const renderShapeOutlineIcon = (shape: ShapeType) => {
    const baseProps = {
      width: 18,
      height: 18,
      viewBox: "0 0 24 24",
      className: "shrink-0",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round" as const,
      strokeLinejoin: "round" as const,
    };

    if (shape === "rectangle") {
      return <svg {...baseProps}><rect x="4" y="5" width="16" height="14" /></svg>;
    }

    if (shape === "ellipse") {
      return <svg {...baseProps}><ellipse cx="12" cy="12" rx="8" ry="6.5" /></svg>;
    }

    if (shape === "line") {
      return <svg {...baseProps}><line x1="4" y1="18" x2="20" y2="6" /></svg>;
    }

    if (shape === "star") {
      return <svg {...baseProps}><polygon points="12,2.5 14.8,8.5 21.5,9.2 16.4,13.6 18,20.8 12,16.8 6,20.8 7.6,13.6 2.5,9.2 9.2,8.5" /></svg>;
    }

    if (shape === "star-of-david") {
      return <svg {...baseProps}><polygon points="12,3 19,15 5,15" /><polygon points="12,21 19,9 5,9" /></svg>;
    }

    if (shape === "northern-star") {
      return <svg {...baseProps}><polygon points="12,2 14.5,8.8 22,12 14.5,15.2 12,22 9.5,15.2 2,12 9.5,8.8" /></svg>;
    }

    if (shape === "arrow") {
      return <svg {...baseProps}><polygon points="3,9 14,9 14,5 21,12 14,19 14,15 3,15" /></svg>;
    }

    if (shape === "heart") {
      return <svg {...baseProps}><path d="M12 21 C4 15,3 10,6.5 7.5 C8.7 5.9,11 6.7,12 8.6 C13 6.7,15.3 5.9,17.5 7.5 C21 10,20 15,12 21 Z" /></svg>;
    }

    return <svg {...baseProps}><polygon points="2,12 7,7 7,10 17,10 17,7 22,12 17,17 17,14 7,14 7,17" /></svg>;
  };

  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-100 text-zinc-900">
      <header className="relative z-50 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">CollBrush</h1>
            <p className="text-sm text-zinc-500">
              Board: <span className="font-medium text-zinc-700">{boardId}</span> · {usersCount}/10 online
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {boardUsers.map((user) => (
                <span
                  key={user.socketId}
                  className="rounded-full border bg-white px-2 py-0.5 text-xs font-medium"
                  style={{
                    color: user.cursorColor,
                    borderColor: user.cursorColor,
                  }}
                >
                  {user.animalEmoji} {user.nickname}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setMode("draw")}
              title="Pen (Q)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "draw" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              ✏️ Pen
            </button>
            <button
              type="button"
              onClick={() => setMode("erase")}
              title="Eraser (E)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "erase" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🧽 Eraser
            </button>
            <button
              type="button"
              onClick={() => setMode("bucket")}
              title="Bucket (B)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "bucket" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🪣 Bucket
            </button>
            <button
              type="button"
              onClick={() => setMode("select")}
              title="Select (S)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "select" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🔲 Select
            </button>
            <button
              type="button"
              onClick={() => setMode("drag")}
              title="Drag (D)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "drag" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              ✋ Drag
            </button>
            <button
              type="button"
              onClick={() => setMode("picker")}
              title="Picker (P)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "picker" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🎨 Picker
            </button>
            <button
              type="button"
              onClick={() => setMode("zoom")}
              title="Magnifier (G) · LMB in / RMB out · hold for continuous zoom"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "zoom" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🔍 Zoom
            </button>
            <button
              type="button"
              onClick={() => setMode("text")}
              title="Text (T)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "text" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🔤 Text
            </button>
            <button
              type="button"
              onClick={() => setMode("sticky")}
              title="Sticky (N)"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "sticky" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🗒️ Sticky
            </button>
            <div ref={shapeMenuContainerRef} className="relative">
              <button
                type="button"
                onClick={() => setShapeMenuOpen((previous) => !previous)}
                title="Shapes (C)"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  mode === "shape" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {renderShapeOutlineIcon(activeShape)}
                  <span>{activeShapeLabel}</span>
                </span>
              </button>
              {shapeMenuOpen ? (
                <div
                  ref={shapeMenuRef}
                  className="absolute left-0 top-full z-[120] mt-1 max-h-[70vh] w-52 overflow-y-auto overscroll-contain rounded-md border border-zinc-300 bg-white p-1 shadow-lg"
                >
                  {shapeOptions.map(({ value: shapeValue, label }) => (
                    <button
                      key={shapeValue}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                        activeShape === shapeValue ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
                      }`}
                      onClick={() => {
                        setActiveShape(shapeValue);
                        setMode("shape");
                        setShapeMenuOpen(false);
                      }}
                    >
                      {renderShapeOutlineIcon(shapeValue)}
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="mx-1 h-6 w-px bg-zinc-300" />

            <label className="flex items-center gap-2 text-sm text-zinc-600">
              Color
              <input
                type="color"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                  if (mode === "picker") {
                    setMode("draw");
                  }
                }}
                className="h-8 w-10 cursor-pointer rounded border border-zinc-300 bg-white p-1"
                aria-label="Pick drawing color"
              />
            </label>

            <label className="ml-2 flex items-center gap-2 text-sm text-zinc-600">
              Size
              <input
                type="range"
                min={1}
                max={40}
                value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))}
              />
            </label>

            <button
              type="button"
              onClick={clearBoard}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-700"
            >
              🧹 Clear
            </button>

            <button
              type="button"
              onClick={async () => {
                if (!boardLink) {
                  return;
                }

                await navigator.clipboard.writeText(boardLink);
              }}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700"
            >
              🔗 Copy link
            </button>

          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-2 p-3 sm:p-4">
        <style jsx global>{`
          .cb-block-spoiler {
            filter: blur(6px);
            transition: filter 120ms ease;
          }

          .cb-block-spoiler:hover,
          .cb-reveal-spoilers.cb-block-spoiler {
            filter: blur(0);
          }

          .cb-inline-spoiler {
            filter: blur(3px);
            transition: filter 120ms ease;
          }

          .cb-inline-spoiler:hover,
          .cb-reveal-spoilers .cb-inline-spoiler,
          .cb-reveal-spoilers [data-inline-spoiler="true"] {
            filter: blur(0);
            background: transparent;
          }
        `}</style>
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <span>{isConnected ? "Connected" : "Connecting..."}</span>
          {joinError ? <span className="font-medium text-red-600">{joinError}</span> : null}
        </div>

        <div ref={containerRef} className="relative min-h-[60vh] flex-1 overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-sm">
          <div
            className="absolute inset-0"
            style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
            }}
          >
          <canvas
            ref={canvasRef}
            className="h-full w-full touch-none"
            onPointerDown={startDrawing}
            onPointerMove={continueDrawing}
            onPointerUp={stopDrawing}
            onPointerLeave={stopDrawing}
            onPointerCancel={stopDrawing}
            onPointerEnter={emitCursorOnEnter}
            onContextMenu={(event) => {
              if (mode === "zoom") {
                event.preventDefault();
                clearZoomHold();
              }
            }}
          />

          {Object.values(boardObjects).map((object) => (
            <div
              key={object.id}
              className={`absolute z-20 select-none ${
                editingObjectId === object.id ? "cursor-text" : "cursor-move"
              }`}
              style={{
                left: `${(object.x / canvasSize.width) * 100}%`,
                top: `${(object.y / canvasSize.height) * 100}%`,
                width: `${(object.width / canvasSize.width) * 100}%`,
                height: `${(object.height / canvasSize.height) * 100}%`,
                minWidth: "60px",
                minHeight: "40px",
                transform: `rotate(${object.rotation}deg) scale(${object.flipX ? -1 : 1}, ${object.flipY ? -1 : 1})`,
                transformOrigin: "center center",
              }}
              onPointerDown={(event) => onObjectPointerDown(event, object)}
              onPointerMove={onObjectPointerMove}
              onPointerUp={onObjectPointerUp}
              onPointerCancel={onObjectPointerUp}
              onDoubleClick={() => onObjectDoubleClick(object)}
              onPointerEnter={() => setHoveredObjectId(object.id)}
              onPointerLeave={() =>
                setHoveredObjectId((previousHoveredId) =>
                  previousHoveredId === object.id ? null : previousHoveredId,
                )
              }
            >
              {activeObjectId === object.id ? (
                <div
                  ref={activeObjectId === object.id ? activeToolbarRef : null}
                  className="absolute bottom-full left-0 z-30 mb-2 flex flex-wrap items-center gap-1 rounded-md border border-zinc-300 bg-white p-1 shadow"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <select
                    value={object.style.fontFamily}
                    onChange={(event) => updateFontFamily(event.target.value)}
                    className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs"
                  >
                    <option value="Arial">Arial</option>
                    <option value="Verdana">Verdana</option>
                    <option value="Tahoma">Tahoma</option>
                    <option value="Times New Roman">Times</option>
                    <option value="Courier New">Courier</option>
                    <option value="Georgia">Georgia</option>
                  </select>
                  <input
                    type="number"
                    min={8}
                    max={120}
                    value={object.style.fontSize}
                    onChange={(event) => updateFontSize(Number(event.target.value))}
                    className="w-14 rounded border border-zinc-300 px-1 py-0.5 text-xs"
                  />
                  <input
                    type="color"
                    value={object.style.color}
                    onChange={(event) => updateFontColor(event.target.value)}
                    className="h-6 w-8 rounded border border-zinc-300"
                  />
                  <button
                    type="button"
                    onClick={() => updateTextStyleFlag("bold")}
                    className={`rounded px-1.5 py-0.5 text-xs font-bold ${
                      object.style.bold ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700"
                    }`}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={() => updateTextStyleFlag("italic")}
                    className={`rounded px-1.5 py-0.5 text-xs italic ${
                      object.style.italic ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700"
                    }`}
                  >
                    I
                  </button>
                  <button
                    type="button"
                    onClick={() => updateTextStyleFlag("strikethrough")}
                    className={`rounded px-1.5 py-0.5 text-xs line-through ${
                      object.style.strikethrough ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700"
                    }`}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    onClick={() => updateTextStyleFlag("spoiler")}
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      object.style.spoiler ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700"
                    }`}
                  >
                    Spoiler
                  </button>
                </div>
              ) : null}

              {object.type === "text" ? (
                editingObjectId === object.id ? (
                  <div
                    ref={editingObjectId === object.id ? editingElementRef : null}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={(event) => onObjectContentChange(object.id, event.currentTarget.innerHTML)}
                    onBlur={finishObjectEditing}
                    className="h-full w-full overflow-auto rounded border border-zinc-300 bg-white/90 px-1 py-0.5 outline-none"
                    style={{
                      fontFamily: object.style.fontFamily,
                      fontSize: `${object.style.fontSize}px`,
                      color: object.style.color,
                      fontWeight: object.style.bold ? 700 : 400,
                      fontStyle: object.style.italic ? "italic" : "normal",
                      textDecoration: object.style.strikethrough ? "line-through" : "none",
                    }}
                  />
                ) : (
                  <div
                    className={`rounded border px-1 py-0.5 ${
                      activeObjectId === object.id ? "border-blue-400" : "border-transparent"
                    } ${
                      object.style.spoiler && hoveredObjectId !== object.id ? "cb-block-spoiler" : ""
                    } ${
                      hoveredObjectId === object.id ? "cb-reveal-spoilers" : ""
                    }`}
                    style={{
                      width: "100%",
                      minHeight: "100%",
                      fontFamily: object.style.fontFamily,
                      fontSize: `${object.style.fontSize}px`,
                      color: object.style.color,
                      fontWeight: object.style.bold ? 700 : 400,
                      fontStyle: object.style.italic ? "italic" : "normal",
                      textDecoration: object.style.strikethrough ? "line-through" : "none",
                      textShadow: "none",
                      whiteSpace: "pre-wrap",
                    }}
                    title={object.style.spoiler ? "Spoiler text" : undefined}
                    dangerouslySetInnerHTML={{ __html: toMarkupContent(object.content) || " " }}
                  >
                  </div>
                )
              ) : (
                editingObjectId === object.id ? (
                  <div
                    ref={editingObjectId === object.id ? editingElementRef : null}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={(event) => onObjectContentChange(object.id, event.currentTarget.innerHTML)}
                    onBlur={finishObjectEditing}
                    className="h-full w-full overflow-auto rounded border border-amber-600 bg-[#E1AD01] px-3 py-2 outline-none shadow-sm"
                    style={{
                      fontFamily: object.style.fontFamily,
                      fontSize: `${object.style.fontSize}px`,
                      color: object.style.color,
                      fontWeight: object.style.bold ? 700 : 400,
                      fontStyle: object.style.italic ? "italic" : "normal",
                      textDecoration: object.style.strikethrough ? "line-through" : "none",
                      textShadow: "none",
                    }}
                  />
                ) : (
                  <div
                    className={`rounded border bg-[#E1AD01] px-3 py-2 shadow-sm ${
                      activeObjectId === object.id ? "border-blue-500" : "border-amber-500"
                    } ${
                      object.style.spoiler && hoveredObjectId !== object.id ? "cb-block-spoiler" : ""
                    } ${hoveredObjectId === object.id ? "cb-reveal-spoilers" : ""}`}
                    style={{
                      width: "100%",
                      minHeight: "100%",
                      fontFamily: object.style.fontFamily,
                      fontSize: `${object.style.fontSize}px`,
                      color: object.style.color,
                      fontWeight: object.style.bold ? 700 : 400,
                      fontStyle: object.style.italic ? "italic" : "normal",
                      textDecoration: object.style.strikethrough ? "line-through" : "none",
                      textShadow: "none",
                    }}
                    dangerouslySetInnerHTML={{ __html: toMarkupContent(object.content) || " " }}
                  >
                  </div>
                )
              )}

              <button
                type="button"
                className="absolute bottom-0 left-0 h-4 w-4 -translate-x-1/2 translate-y-1/2 cursor-move rounded-sm border border-zinc-700 bg-white text-[10px] leading-none"
                onPointerDown={(event) => onObjectDragHandlePointerDown(event, object)}
                aria-label="Drag object"
                title="Drag object"
              >
                ✥
              </button>

              <button
                type="button"
                className="absolute bottom-0 right-5 h-4 w-4 translate-x-1/2 translate-y-1/2 cursor-alias rounded-sm border border-zinc-700 bg-white text-[10px] leading-none"
                onPointerDown={(event) => onObjectRotatePointerDown(event, object)}
                aria-label="Rotate object"
                title="Rotate"
              >
                ↻
              </button>

              <button
                type="button"
                className="absolute bottom-0 right-0 h-4 w-4 translate-x-1/2 translate-y-1/2 cursor-se-resize rounded-sm border border-zinc-700 bg-white"
                onPointerDown={(event) => onObjectResizePointerDown(event, object)}
                aria-label="Resize object"
              />
            </div>
          ))}

          {displayedSelection ? (
            <>
              <div
                className="pointer-events-none absolute"
                style={{
                  left: `${(displayedSelection.x / canvasSize.width) * 100}%`,
                  top: `${(displayedSelection.y / canvasSize.height) * 100}%`,
                  width: `${(displayedSelection.width / canvasSize.width) * 100}%`,
                  height: `${(displayedSelection.height / canvasSize.height) * 100}%`,
                  transform: `rotate(${displayedSelectionRotation}deg)`,
                  transformOrigin: "center center",
                }}
              >
                <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-blue-500 bg-blue-200/20" />

                <button
                  type="button"
                  className="pointer-events-auto absolute right-0 top-0 z-30 h-4 w-4 -translate-y-1/2 translate-x-1/2 cursor-alias rounded-sm border border-zinc-700 bg-white text-[10px] leading-none"
                  onPointerDown={(event) => beginSelectionTransform("rotate", event)}
                  onPointerMove={updateSelectionTransform}
                  onPointerUp={finishSelectionTransform}
                  onPointerCancel={finishSelectionTransform}
                  aria-label="Rotate selection"
                  title="Rotate selection"
                >
                  ↻
                </button>

                <button
                  type="button"
                  className="pointer-events-auto absolute right-0 top-0 z-30 h-4 w-4 translate-x-1/2 cursor-se-resize rounded-sm border border-zinc-700 bg-white"
                  style={{ top: "30px" }}
                  onPointerDown={(event) => beginSelectionTransform("resize", event)}
                  onPointerMove={updateSelectionTransform}
                  onPointerUp={finishSelectionTransform}
                  onPointerCancel={finishSelectionTransform}
                  aria-label="Resize selection"
                  title="Resize selection"
                />

                <button
                  type="button"
                  className="pointer-events-auto absolute bottom-0 left-0 z-30 h-4 w-4 translate-y-1/2 -translate-x-1/2 cursor-move rounded-sm border border-zinc-700 bg-white text-[10px] leading-none"
                  onPointerDown={startSelectionDragFromHandle}
                  onPointerMove={updateSelectionDragFromHandle}
                  onPointerUp={finishSelectionDragFromHandle}
                  onPointerCancel={finishSelectionDragFromHandle}
                  aria-label="Drag selection"
                  title="Drag selection"
                >
                  ✥
                </button>
              </div>
              <div
                className="absolute z-30 flex gap-1"
                style={{
                  left: `${(displayedSelection.x / canvasSize.width) * 100}%`,
                  top: `${Math.max(0, ((displayedSelection.y - 32) / canvasSize.height) * 100)}%`,
                }}
              >
                <button
                  type="button"
                  onClick={() => flipSelectionPixels("horizontal")}
                  className="rounded border border-zinc-400 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 shadow hover:bg-zinc-50"
                  title="Flip Horizontal"
                >
                  ↔ Flip
                </button>
                <button
                  type="button"
                  onClick={() => flipSelectionPixels("vertical")}
                  className="rounded border border-zinc-400 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 shadow hover:bg-zinc-50"
                  title="Flip Vertical"
                >
                  ↕ Flip
                </button>
              </div>
            </>
          ) : null}

          {objectCreatePreview ? (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-zinc-700/70 bg-zinc-300/20"
              style={{
                left: `${(objectCreatePreview.x / canvasSize.width) * 100}%`,
                top: `${(objectCreatePreview.y / canvasSize.height) * 100}%`,
                width: `${(objectCreatePreview.width / canvasSize.width) * 100}%`,
                height: `${(objectCreatePreview.height / canvasSize.height) * 100}%`,
              }}
            />
          ) : null}

          {Object.values(remoteCursors).map((cursorState) => (
            <div
              key={cursorState.socketId}
              className="pointer-events-none absolute z-10"
              style={{
                left: `${cursorState.x * 100}%`,
                top: `${cursorState.y * 100}%`,
                transform: "translate(8px, 8px)",
              }}
            >
              <div
                className="h-2.5 w-2.5 rounded-full ring-2 ring-white"
                style={{ backgroundColor: cursorState.cursorColor }}
              />
              <div
                className="mt-1 rounded border bg-white px-1.5 py-0.5 text-xs font-medium"
                style={{
                  color: cursorState.cursorColor,
                  borderColor: cursorState.cursorColor,
                }}
              >
                {cursorState.nickname}
              </div>
            </div>
          ))}

          {joinError ? (
            <div className="absolute inset-0 grid place-items-center bg-white/80 text-center text-sm font-medium text-red-600">
              {joinError}
            </div>
          ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
