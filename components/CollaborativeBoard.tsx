"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { readStoredAccount, saveAccount } from "@/lib/account";
import { removeLocalBoardPresence, upsertLocalBoardPresence } from "@/lib/board-presence";
import { readStoredBoards, upsertStoredBoard } from "@/lib/boards";
import { getSocketServerUrl } from "@/lib/runtime-config";
import type {
  BoardAction,
  BoardObject,
  BoardUser,
  CursorState,
  DrawSegment,
  FillAction,
  JoinBoardResponse,
  Point,
  ReplaceCanvasAction,
  TextStyle,
} from "@/lib/protocol";
import type {
  BottleBurst,
  CoinflipBurst,
  CollaborativeBoardProps,
  ConfettiPiece,
  ConfettiBurst,
  CreateObjectSession,
  ResizeSession,
  RotateSession,
  SelectionRect,
  SelectionTransformMode,
  SelectionTransformSession,
  ShapeSession,
  ShapeType,
  SharknadoBreakaway,
  SharknadoBurst,
  SharknadoShark,
  SnapshotHistoryEntry,
  ToolMode,
} from "./collaborative-board/types";
import {
  applyFillToContext,
  BOTTLE_NECK_ANGLE,
  clamp,
  DEFAULT_TEXT_STYLE,
  drawReplaceOnContext,
  drawSegmentOnContext,
  drawShapeOutline,
  drawWrappedText,
  extractPlainText,
  getRandomBit,
  getRandomIntInclusive,
  normalizeBoardObject,
  normalizeRect,
  pointInRect,
  rgbaToHex,
  toMarkupContent,
} from "./collaborative-board/utils";
import {
  getShapeLabel,
  renderShapeOutlineIcon,
  SHAPE_OPTIONS,
} from "./collaborative-board/shape-config";

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
  const boardDirtyRef = useRef(false);
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
  const screenshotMenuContainerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const uploadImageInputRef = useRef<HTMLInputElement | null>(null);
  const copiedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastContextMenuPointRef = useRef<Point | null>(null);
  const confettiTimeoutsRef = useRef<number[]>([]);
  const selectionTransformSessionRef = useRef<SelectionTransformSession | null>(null);
  const zoomHoldTimeoutRef = useRef<number | null>(null);
  const zoomHoldIntervalRef = useRef<number | null>(null);
  const saveProgressTimeoutRef = useRef<number | null>(null);
  const editingElementRef = useRef<HTMLDivElement | null>(null);
  const activeToolbarRef = useRef<HTMLDivElement | null>(null);
  const selectedTextRangeRef = useRef<Range | null>(null);

  const isDrawingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const middlePanPointerIdRef = useRef<number | null>(null);
  const middlePanLastClientRef = useRef<Point | null>(null);
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
  const [screenshotMenuOpen, setScreenshotMenuOpen] = useState(false);
  const [pendingScreenshotSelection, setPendingScreenshotSelection] = useState(false);
  const [contextMenuState, setContextMenuState] = useState<{ x: number; y: number } | null>(null);
  const [confettiBursts, setConfettiBursts] = useState<ConfettiBurst[]>([]);
  const [sharknadoBursts, setSharknadoBursts] = useState<SharknadoBurst[]>([]);
  const [coinflipBursts, setCoinflipBursts] = useState<CoinflipBurst[]>([]);
  const [bottleBursts, setBottleBursts] = useState<BottleBurst[]>([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [saveProgressNotice, setSaveProgressNotice] = useState<string>("");

  const boardLink = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return `${window.location.origin}/board/${boardId}`;
  }, [boardId]);

  const getCanvasPoint = useCallback(
    (
      event:
        | PointerEvent
        | MouseEvent
        | React.PointerEvent<Element>
        | React.MouseEvent<Element>,
    ): Point | null => {
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
    },
    [],
  );

  const closeBoardContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);

  const launchConfetti = useCallback((x: number, y: number) => {
    const burstId = `confetti-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const colorClasses = [
      "bg-blue-500",
      "bg-emerald-500",
      "bg-amber-500",
      "bg-rose-500",
      "bg-violet-500",
      "bg-cyan-500",
    ];

    const pieces: ConfettiPiece[] = Array.from({ length: 44 }, (_, index) => {
      const distance = 60 + Math.random() * 260;
      const angle = (Math.PI * 2 * index) / 44 + Math.random() * 0.45;
      return {
        id: `${burstId}-${index}`,
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance - (80 + Math.random() * 100),
        rotation: -420 + Math.random() * 840,
        duration: 760 + Math.random() * 540,
        delay: Math.random() * 140,
        colorClass: colorClasses[Math.floor(Math.random() * colorClasses.length)],
      };
    });

    setConfettiBursts((previous) => [...previous, { id: burstId, x, y, pieces }]);
    const timeoutId = window.setTimeout(() => {
      setConfettiBursts((previous) => previous.filter((burst) => burst.id !== burstId));
      confettiTimeoutsRef.current = confettiTimeoutsRef.current.filter((id) => id !== timeoutId);
    }, 1800);
    confettiTimeoutsRef.current.push(timeoutId);
  }, []);

  const launchSharknado = useCallback((x: number, y: number) => {
    const burstId = `sharknado-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sharks: SharknadoShark[] = Array.from({ length: 16 }, (_, index) => ({
      id: `${burstId}-${index}`,
      lane: -46 + index * 6.4,
      sway: 44 + Math.random() * 34,
      startScale: 0.48 + Math.random() * 0.18,
      peakScale: 1.02 + Math.random() * 0.22,
      endScale: 0.56 + Math.random() * 0.2,
      drift: 76 + Math.random() * 46,
      delay: index * 11,
      duration: 550 + Math.random() * 260,
    }));

    const breakaways: SharknadoBreakaway[] = Array.from({ length: 6 }, (_, index) => {
      const angle = Math.random() * Math.PI * 2;
      const distance = 220 + Math.random() * 360;
      return {
        id: `${burstId}-breakaway-${index}`,
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance - (40 + Math.random() * 220),
        rotation: -540 + Math.random() * 1080,
        scale: 0.7 + Math.random() * 0.5,
        delay: 120 + Math.random() * 320,
        duration: 460 + Math.random() * 340,
      };
    });

    setSharknadoBursts((previous) => [
      ...previous,
      {
        id: burstId,
        x,
        y,
        sharks,
        breakaways,
        wobbleX: 10 + Math.random() * 12,
        wobbleY: 7 + Math.random() * 10,
        wobbleDuration: 360 + Math.random() * 260,
      },
    ]);
    const timeoutId = window.setTimeout(() => {
      setSharknadoBursts((previous) => previous.filter((burst) => burst.id !== burstId));
      confettiTimeoutsRef.current = confettiTimeoutsRef.current.filter((id) => id !== timeoutId);
    }, 4200);
    confettiTimeoutsRef.current.push(timeoutId);
  }, []);

  const launchCoinflip = useCallback((x: number, y: number) => {
    const burstId = `coinflip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result: "Heads" | "Tails" = getRandomBit() === 0 ? "Heads" : "Tails";

    setCoinflipBursts((previous) => [...previous, { id: burstId, x, y, result }]);
    const timeoutId = window.setTimeout(() => {
      setCoinflipBursts((previous) => previous.filter((burst) => burst.id !== burstId));
      confettiTimeoutsRef.current = confettiTimeoutsRef.current.filter((id) => id !== timeoutId);
    }, 3800);
    confettiTimeoutsRef.current.push(timeoutId);
  }, []);

  const launchBottleSpin = useCallback(
    (x: number, y: number) => {
      if (boardUsers.length === 0) {
        return;
      }

      const container = containerRef.current;
      const ringRadius = 100;
      const centerX = container
        ? clamp(x, ringRadius + 12, Math.max(ringRadius + 12, container.clientWidth - ringRadius - 12))
        : x;
      const centerY = container
        ? clamp(y, ringRadius + 12, Math.max(ringRadius + 12, container.clientHeight - ringRadius - 12))
        : y;

      const burstId = `bottle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const participants = boardUsers.map((user, index) => ({
        id: user.socketId,
        nickname: user.nickname,
        emoji: user.animalEmoji,
        color: user.cursorColor,
        angle: -90 + (index * 360) / boardUsers.length,
      }));

      const selectedIndex = getRandomIntInclusive(0, participants.length - 1);
      const selected = participants[selectedIndex];
      if (!selected) {
        return;
      }

      const targetAngle = selected.angle;
      const normalizedTargetRotation = ((targetAngle - BOTTLE_NECK_ANGLE) % 360 + 360) % 360;
      const spins = 6 + Math.random() * 6;
      const bottleRotation = spins * 360 + normalizedTargetRotation;
      const duration = 2400 + getRandomIntInclusive(0, 700);

      setBottleBursts((previous) => [
        ...previous,
        {
          id: burstId,
          x: centerX,
          y: centerY,
          participants,
          selectedId: selected.id,
          bottleRotation,
          duration,
        },
      ]);

      const timeoutId = window.setTimeout(() => {
        setBottleBursts((previous) => previous.filter((burst) => burst.id !== burstId));
        confettiTimeoutsRef.current = confettiTimeoutsRef.current.filter((id) => id !== timeoutId);
      }, duration + 1800);
      confettiTimeoutsRef.current.push(timeoutId);
    },
    [boardUsers],
  );

  const markBoardDirty = useCallback(() => {
    boardDirtyRef.current = true;
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

  const renderBoardToCanvas = useCallback(() => {
    const sourceCanvas = canvasRef.current;
    if (!sourceCanvas) {
      return null;
    }

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = sourceCanvas.width;
    outputCanvas.height = sourceCanvas.height;

    const ctx = outputCanvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0);

    for (const object of Object.values(boardObjects)) {
      const style = {
        ...DEFAULT_TEXT_STYLE,
        ...object.style,
      };
      const width = Math.max(1, Math.floor(object.width));
      const height = Math.max(1, Math.floor(object.height));
      const x = Math.floor(object.x);
      const y = Math.floor(object.y);

      ctx.save();
      ctx.translate(x + width / 2, y + height / 2);
      ctx.rotate(((object.rotation ?? 0) * Math.PI) / 180);
      ctx.scale(object.flipX ? -1 : 1, object.flipY ? -1 : 1);
      ctx.translate(-width / 2, -height / 2);

      if (object.type === "sticky") {
        ctx.fillStyle = "#E1AD01";
        ctx.strokeStyle = "#B45309";
      } else {
        ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
        ctx.strokeStyle = "rgba(148, 163, 184, 0.85)";
      }

      ctx.lineWidth = 1;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeRect(0, 0, width, height);

      if (style.spoiler) {
        ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
        continue;
      }

      const fontSize = Math.max(8, style.fontSize || DEFAULT_TEXT_STYLE.fontSize);
      const fontFamily = style.fontFamily || DEFAULT_TEXT_STYLE.fontFamily;
      const fontWeight = style.bold ? "700" : "400";
      const fontStyle = style.italic ? "italic" : "normal";
      ctx.fillStyle = style.color || DEFAULT_TEXT_STYLE.color;
      ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
      ctx.textBaseline = "top";

      const text = extractPlainText(object.content);
      const padding = object.type === "sticky" ? 12 : 6;
      const lineHeight = Math.max(12, Math.round(fontSize * 1.35));
      drawWrappedText(
        ctx,
        text,
        padding,
        padding,
        Math.max(1, width - padding * 2),
        Math.max(1, height - padding * 2),
        lineHeight,
        Boolean(style.strikethrough),
      );

      ctx.restore();
    }

    return outputCanvas;
  }, [boardObjects]);

  const downloadPngScreenshot = useCallback(
    (scope: "board" | "selection", rect?: SelectionRect) => {
      const composedCanvas = renderBoardToCanvas();
      if (!composedCanvas) {
        return;
      }

      let exportCanvas = composedCanvas;
      if (scope === "selection" && rect) {
        const cropX = clamp(Math.floor(rect.x), 0, Math.max(0, composedCanvas.width - 1));
        const cropY = clamp(Math.floor(rect.y), 0, Math.max(0, composedCanvas.height - 1));
        const cropWidth = clamp(
          Math.floor(rect.width),
          1,
          Math.max(1, composedCanvas.width - cropX),
        );
        const cropHeight = clamp(
          Math.floor(rect.height),
          1,
          Math.max(1, composedCanvas.height - cropY),
        );

        const croppedCanvas = document.createElement("canvas");
        croppedCanvas.width = cropWidth;
        croppedCanvas.height = cropHeight;
        const cropCtx = croppedCanvas.getContext("2d");
        if (!cropCtx) {
          return;
        }

        cropCtx.fillStyle = "#ffffff";
        cropCtx.fillRect(0, 0, cropWidth, cropHeight);
        cropCtx.drawImage(
          composedCanvas,
          cropX,
          cropY,
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight,
        );
        exportCanvas = croppedCanvas;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const link = document.createElement("a");
      link.href = exportCanvas.toDataURL("image/png");
      link.download = `${boardId}-${scope}-${timestamp}.png`;
      link.click();
    },
    [boardId, renderBoardToCanvas],
  );

  const startSelectionScreenshotMode = useCallback(() => {
    setScreenshotMenuOpen(false);
    setShapeMenuOpen(false);
    setPendingScreenshotSelection(true);
    setMode("select");
    setSelectionRect(null);
    setSelectionPreviewRect(null);
    setSelectionRotation(0);
    setSelectionPreviewRotation(null);
  }, []);

  const persistBoardPreview = useCallback(() => {
    if (!boardDirtyRef.current) {
      return;
    }

    const account = readStoredAccount();
    const safeUserId = (account?.userId || userId).trim().slice(0, 80);
    if (!safeUserId) {
      return;
    }

    const existing = readStoredBoards(safeUserId).find((board) => board.id === boardId);

    const composed = renderBoardToCanvas();
    if (!composed || composed.width <= 0 || composed.height <= 0) {
      return;
    }

    const previewWidth = 360;
    const previewHeight = Math.max(1, Math.round((composed.height / composed.width) * previewWidth));
    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = previewWidth;
    previewCanvas.height = previewHeight;
    const previewCtx = previewCanvas.getContext("2d");
    if (!previewCtx) {
      return;
    }

    previewCtx.fillStyle = "#ffffff";
    previewCtx.fillRect(0, 0, previewWidth, previewHeight);
    previewCtx.drawImage(composed, 0, 0, previewWidth, previewHeight);

    upsertStoredBoard(safeUserId, {
      id: boardId,
      name: existing?.name ?? boardId,
      previewDataUrl: previewCanvas.toDataURL("image/jpeg", 0.82),
    });
    boardDirtyRef.current = false;
  }, [boardId, renderBoardToCanvas, userId]);

  const upsertBoardObject = useCallback((object: BoardObject, broadcast: boolean) => {
    const normalized = normalizeBoardObject(object);

    setBoardObjects((previous) => ({
      ...previous,
      [normalized.id]: normalized,
    }));

    if (broadcast) {
      socketRef.current?.emit("upsert-object", normalized);
      markBoardDirty();
    }
  }, [markBoardDirty]);

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
      markBoardDirty();
    }
  }, [markBoardDirty]);

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

    markBoardDirty();
    undoStackRef.current.push(entry);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.splice(0, undoStackRef.current.length - 50);
    }

    redoStackRef.current = [];
  }, [markBoardDirty]);

  const loadImageFromBlob = useCallback(async (blob: Blob) => {
    const imageUrl = URL.createObjectURL(blob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const next = new Image();
        next.onload = () => resolve(next);
        next.onerror = () => reject(new Error("Failed to load image"));
        next.src = imageUrl;
      });
      return image;
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  }, []);

  const insertImageElement = useCallback(
    (image: HTMLImageElement, anchorPoint?: Point | null) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return false;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return false;
      }

      const imageWidth = image.naturalWidth || image.width;
      const imageHeight = image.naturalHeight || image.height;
      if (imageWidth <= 0 || imageHeight <= 0) {
        return false;
      }

      const maxWidth = Math.max(1, Math.floor(canvas.width * 0.9));
      const maxHeight = Math.max(1, Math.floor(canvas.height * 0.9));
      const scale = Math.min(1, maxWidth / imageWidth, maxHeight / imageHeight);
      const drawWidth = Math.max(1, Math.round(imageWidth * scale));
      const drawHeight = Math.max(1, Math.round(imageHeight * scale));

      const point = anchorPoint ?? {
        x: canvas.width / 2,
        y: canvas.height / 2,
      };
      const drawX = clamp(Math.floor(point.x - drawWidth / 2), 0, Math.max(0, canvas.width - drawWidth));
      const drawY = clamp(Math.floor(point.y - drawHeight / 2), 0, Math.max(0, canvas.height - drawHeight));

      const beforeSnapshot = getCanvasSnapshot();
      ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
      setSelectionRect({
        x: drawX,
        y: drawY,
        width: drawWidth,
        height: drawHeight,
      });
      setSelectionPreviewRect(null);
      setSelectionRotation(0);
      setSelectionPreviewRotation(null);
      commitCanvasSnapshot();
      pushHistoryEntry({
        before: beforeSnapshot,
        after: getCanvasSnapshot(),
      });
      return true;
    },
    [commitCanvasSnapshot, getCanvasSnapshot, pushHistoryEntry],
  );

  const rememberCopiedSelection = useCallback((rect: SelectionRect) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }

    const buffer = document.createElement("canvas");
    buffer.width = Math.max(1, rect.width);
    buffer.height = Math.max(1, rect.height);
    const bufferCtx = buffer.getContext("2d");
    if (!bufferCtx) {
      return null;
    }

    bufferCtx.drawImage(
      canvas,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    copiedCanvasRef.current = buffer;
    return buffer;
  }, []);

  const copySelectionToClipboard = useCallback(async () => {
    const rect = selectionRect;
    if (!rect) {
      return false;
    }

    const copied = rememberCopiedSelection(rect);
    if (!copied) {
      return false;
    }

    if (
      typeof window.ClipboardItem !== "undefined" &&
      navigator.clipboard &&
      "write" in navigator.clipboard
    ) {
      try {
        const blob = await new Promise<Blob | null>((resolve) => {
          copied.toBlob((nextBlob) => resolve(nextBlob), "image/png");
        });

        if (blob) {
          await navigator.clipboard.write([
            new window.ClipboardItem({
              "image/png": blob,
            }),
          ]);
        }
      } catch {
        // Fallback to internal copied canvas only.
      }
    }

    return true;
  }, [rememberCopiedSelection, selectionRect]);

  const cutSelectionToClipboard = useCallback(async () => {
    const rect = selectionRect;
    if (!rect) {
      return false;
    }

    const copied = await copySelectionToClipboard();
    if (!copied) {
      return false;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return false;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return false;
    }

    const beforeSnapshot = getCanvasSnapshot();
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    setSelectionRect(null);
    setSelectionPreviewRect(null);
    setSelectionRotation(0);
    setSelectionPreviewRotation(null);
    commitCanvasSnapshot();
    pushHistoryEntry({
      before: beforeSnapshot,
      after: getCanvasSnapshot(),
    });
    return true;
  }, [
    commitCanvasSnapshot,
    copySelectionToClipboard,
    getCanvasSnapshot,
    pushHistoryEntry,
    selectionRect,
  ]);

  const pasteImageFromClipboardOrMemory = useCallback(async () => {
    const anchor = lastContextMenuPointRef.current;
    if (navigator.clipboard && "read" in navigator.clipboard) {
      try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
          const imageType = item.types.find((type) => type.startsWith("image/"));
          if (!imageType) {
            continue;
          }

          const blob = await item.getType(imageType);
          const image = await loadImageFromBlob(blob);
          return insertImageElement(image, anchor);
        }
      } catch {
        // Continue with in-memory fallback.
      }
    }

    const copiedCanvas = copiedCanvasRef.current;
    if (!copiedCanvas) {
      return false;
    }

    const fallbackImage = new Image();
    fallbackImage.src = copiedCanvas.toDataURL("image/png");
    await new Promise<void>((resolve, reject) => {
      fallbackImage.onload = () => resolve();
      fallbackImage.onerror = () => reject(new Error("Failed to load copied image"));
    });
    return insertImageElement(fallbackImage, anchor);
  }, [insertImageElement, loadImageFromBlob]);

  const uploadImageFromFile = useCallback(
    async (file: File) => {
      const image = await loadImageFromBlob(file);
      insertImageElement(image, lastContextMenuPointRef.current);
    },
    [insertImageElement, loadImageFromBlob],
  );

  const onUploadImageInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      await uploadImageFromFile(file);
      event.target.value = "";
    },
    [uploadImageFromFile],
  );

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

    const socket = io(getSocketServerUrl(), {
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
        boardDirtyRef.current = true;
      });
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
    });

    socket.on("connect_error", () => {
      setJoinError("Cannot connect to realtime server.");
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
      boardDirtyRef.current = true;
    });

    socket.on("fill-area", (fill: FillAction) => {
      applyBoardAction(
        {
          type: "fill",
          fill,
        },
        true,
      );
      boardDirtyRef.current = true;
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
      boardDirtyRef.current = true;
    });

    socket.on("replace-canvas-preview", (replace: ReplaceCanvasAction) => {
      applyReplaceActionToCanvas(replace);
    });

    socket.on("upsert-object", (object: BoardObject) => {
      upsertBoardObject(object, false);
      boardDirtyRef.current = true;
    });

    socket.on("remove-object", ({ id }: { id: string }) => {
      removeBoardObject(id, false);
      boardDirtyRef.current = true;
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
      boardDirtyRef.current = true;
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

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      persistBoardPreview();
    }, 3000);

    const timeoutId = window.setTimeout(() => {
      persistBoardPreview();
    }, 300);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      persistBoardPreview();
    };
  }, [persistBoardPreview]);

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

    if (event.button === 1 && zoomLevel > 1) {
      pointerIdRef.current = event.pointerId;
      middlePanPointerIdRef.current = event.pointerId;
      middlePanLastClientRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    const isZoomRmb = mode === "zoom" && event.button === 2;
    if (event.button === 2 && mode !== "zoom") {
      return;
    }

    if (event.button !== 0 && !isZoomRmb) {
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
          clamp(Number((previous + 0.25 * zoomDirection).toFixed(2)), 1, 4),
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
    if (middlePanPointerIdRef.current === event.pointerId) {
      const canvas = canvasRef.current;
      const previousClientPoint = middlePanLastClientRef.current;
      if (!canvas || !previousClientPoint || zoomLevel <= 1) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      const deltaX = event.clientX - previousClientPoint.x;
      const deltaY = event.clientY - previousClientPoint.y;
      middlePanLastClientRef.current = {
        x: event.clientX,
        y: event.clientY,
      };

      setZoomOrigin((previous) => ({
        x: clamp(previous.x - (deltaX / rect.width) * 100, 0, 100),
        y: clamp(previous.y - (deltaY / rect.height) * 100, 0, 100),
      }));
      return;
    }

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
    if (middlePanPointerIdRef.current !== null) {
      const shouldStopMiddlePan = !event || middlePanPointerIdRef.current === event.pointerId;
      if (shouldStopMiddlePan) {
        const canvas = canvasRef.current;
        if (event && canvas && middlePanPointerIdRef.current === event.pointerId) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }

        if (pointerIdRef.current === middlePanPointerIdRef.current) {
          pointerIdRef.current = null;
        }

        middlePanPointerIdRef.current = null;
        middlePanLastClientRef.current = null;
        return;
      }
    }

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

          if (pendingScreenshotSelection) {
            downloadPngScreenshot("selection", rect);
            setPendingScreenshotSelection(false);
            setSelectionRect(null);
            setSelectionPreviewRect(null);
            setSelectionRotation(0);
            setSelectionPreviewRotation(null);
            setMode("drag");
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

  const performClearBoard = useCallback(() => {
    const beforeSnapshot = getCanvasSnapshot();
    handleClear();
    socketRef.current?.emit("clear-board");
    pushHistoryEntry({
      before: beforeSnapshot,
      after: getCanvasSnapshot(),
    });
  }, [getCanvasSnapshot, handleClear, pushHistoryEntry]);

  const clearBoard = () => {
    setShowClearConfirm(true);
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

  useEffect(() => () => {
    if (saveProgressTimeoutRef.current !== null) {
      window.clearTimeout(saveProgressTimeoutRef.current);
      saveProgressTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isConnected) {
      removeLocalBoardPresence(boardId, userId);
      return;
    }

    const currentUser = boardUsers.find((user) => user.userId === userId);
    const heartbeat = () => {
      upsertLocalBoardPresence(boardId, {
        userId,
        nickname: currentUser?.nickname ?? nickname,
        animalEmoji: currentUser?.animalEmoji ?? "👤",
        cursorColor: currentUser?.cursorColor ?? "#111827",
      });
    };

    heartbeat();
    const intervalId = window.setInterval(heartbeat, 2000);

    return () => {
      window.clearInterval(intervalId);
      removeLocalBoardPresence(boardId, userId);
    };
  }, [boardId, boardUsers, isConnected, nickname, userId]);

  const handleManualSaveProgress = useCallback(() => {
    boardDirtyRef.current = true;
    persistBoardPreview();
    setSaveProgressNotice("Saved");

    if (saveProgressTimeoutRef.current !== null) {
      window.clearTimeout(saveProgressTimeoutRef.current);
    }

    saveProgressTimeoutRef.current = window.setTimeout(() => {
      setSaveProgressNotice("");
      saveProgressTimeoutRef.current = null;
    }, 1500);
  }, [persistBoardPreview]);

  useEffect(() => () => {
    for (const timeoutId of confettiTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    confettiTimeoutsRef.current = [];
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      if (!imageItem) {
        return;
      }

      const blob = imageItem.getAsFile();
      if (!blob) {
        return;
      }

      event.preventDefault();
      void (async () => {
        const image = await loadImageFromBlob(blob);
        insertImageElement(image, lastContextMenuPointRef.current);
      })();
    };

    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("paste", onPaste);
    };
  }, [insertImageElement, loadImageFromBlob]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!shapeMenuOpen && !screenshotMenuOpen && !contextMenuState) {
        return;
      }

      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      const shapeContainer = shapeMenuContainerRef.current;
      if (shapeMenuOpen && shapeContainer && !shapeContainer.contains(target)) {
        setShapeMenuOpen(false);
      }

      const screenshotContainer = screenshotMenuContainerRef.current;
      if (screenshotMenuOpen && screenshotContainer && !screenshotContainer.contains(target)) {
        setScreenshotMenuOpen(false);
      }

      const boardContextMenu = contextMenuRef.current;
      if (contextMenuState && boardContextMenu && !boardContextMenu.contains(target)) {
        closeBoardContextMenu();
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeBoardContextMenu, contextMenuState, shapeMenuOpen, screenshotMenuOpen]);

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
  const activeShapeLabel = getShapeLabel(activeShape);

  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-100 text-zinc-900">
      <header className="relative z-50 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="mb-2 rounded-md bg-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-300"
            >
              🏠 Main menu
            </button>
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleManualSaveProgress}
                className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700"
              >
                💾 Save progress
              </button>
              {saveProgressNotice ? (
                <span className="text-xs font-medium text-emerald-600">{saveProgressNotice}</span>
              ) : null}
            </div>
            <h1 className="text-lg font-semibold tracking-tight">CollBrush</h1>
            <p className="text-sm text-zinc-500">
              Board: <span className="font-medium text-zinc-700">{boardId}</span> · {usersCount}/10 online
            </p>
            <p className="mt-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Online users</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {boardUsers.length > 0 ? (
                boardUsers.map((user) => (
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
                ))
              ) : (
                <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-500">
                  No users online
                </span>
              )}
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
              title="Magnifier (G) · LMB in / RMB out · hold for continuous zoom · MMB drag to pan when zoomed"
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
                onClick={() => {
                  setShapeMenuOpen((previous) => !previous);
                  setScreenshotMenuOpen(false);
                }}
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
                  {SHAPE_OPTIONS.map(({ value: shapeValue, label }) => (
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

            <div ref={screenshotMenuContainerRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  setScreenshotMenuOpen((previous) => !previous);
                  setShapeMenuOpen(false);
                }}
                title="Screenshot"
                className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-300"
              >
                📸 Screenshot
              </button>
              {screenshotMenuOpen ? (
                <div className="absolute left-0 top-full z-[120] mt-1 w-52 rounded-md border border-zinc-300 bg-white p-1 shadow-lg">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                    onClick={() => {
                      setScreenshotMenuOpen(false);
                      downloadPngScreenshot("board");
                    }}
                  >
                    🖼️ Entire board
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                    onClick={startSelectionScreenshotMode}
                  >
                    ⛶ Selected area
                  </button>
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
                await navigator.clipboard.writeText(boardId);
              }}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700"
            >
              🆔 Copy board ID
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
        {showClearConfirm ? (
          <div className="fixed inset-0 z-[200] grid place-items-center bg-zinc-900/45 px-4 backdrop-blur-[1px]">
            <div className="w-full max-w-sm rounded-xl border border-zinc-300 bg-white p-5 shadow-xl">
              <h2 className="text-base font-semibold text-zinc-900">Clear board?</h2>
              <p className="mt-2 text-sm text-zinc-600">
                Are you sure you want to clear the board? This action affects all users in this board.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(false)}
                  className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowClearConfirm(false);
                    performClearBoard();
                  }}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-700"
                >
                  Yes, clear
                </button>
              </div>
            </div>
          </div>
        ) : null}
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

          @keyframes cb-confetti-pop {
            0% {
              opacity: 0;
              transform: translate(-50%, -55%) scale(0.6);
            }

            15% {
              opacity: 1;
              transform: translate(-50%, -50%) scale(1);
            }

            100% {
              opacity: 0;
              transform: translate(-50%, -72%) scale(0.9);
            }
          }

          @keyframes cb-confetti-fall {
            0% {
              opacity: 1;
              transform: translate(0, 0) rotate(0deg);
            }

            100% {
              opacity: 0;
              transform: translate(var(--cb-dx), var(--cb-dy)) rotate(var(--cb-rot));
            }
          }

          @keyframes cb-sharknado-spin {
            0% {
              opacity: 0;
              transform:
                translate(-50%, -50%)
                translateY(var(--cb-lane))
                translateX(calc(var(--cb-sway) * -0.3))
                scale(var(--cb-start-scale));
            }

            16% {
              opacity: 0.42;
              transform:
                translate(-50%, -50%)
                translateY(calc(var(--cb-lane) - 8px))
                translateX(calc(var(--cb-sway) * -1))
                scale(calc(var(--cb-start-scale) * 0.9));
            }

            46% {
              opacity: 0.98;
              transform:
                translate(-50%, -50%)
                translateY(calc(var(--cb-lane) - 18px))
                translateX(calc(var(--cb-sway) * 0.12))
                scale(var(--cb-peak-scale));
            }

            72% {
              opacity: 0.45;
              transform:
                translate(-50%, -50%)
                translateY(calc(var(--cb-lane) - 34px))
                translateX(var(--cb-sway))
                scale(calc(var(--cb-end-scale) * 0.95));
            }

            100% {
              opacity: 0;
              transform:
                translate(-50%, -50%)
                translateY(calc(var(--cb-lane) - var(--cb-drift)))
                translateX(calc(var(--cb-sway) * -0.25))
                scale(calc(var(--cb-end-scale) * 0.78));
            }
          }

          @keyframes cb-sharknado-breakaway {
            0% {
              opacity: 0;
              transform: translate(0, 0) rotate(0deg) scale(0.65);
            }

            12% {
              opacity: 1;
            }

            100% {
              opacity: 0;
              transform:
                translate(var(--cb-break-dx), var(--cb-break-dy))
                rotate(var(--cb-break-rot))
                scale(var(--cb-break-scale));
            }
          }

          @keyframes cb-sharknado-core {
            0% {
              opacity: 0;
              transform: translate(-50%, -50%) scale(0.8);
            }

            15% {
              opacity: 1;
              transform: translate(-50%, -50%) scale(1.12);
            }

            100% {
              opacity: 0;
              transform: translate(-50%, -58%) scale(1.02);
            }
          }

          @keyframes cb-sharknado-wobble {
            0% {
              transform: translate(0, 0);
            }

            25% {
              transform: translate(var(--cb-wobble-x), calc(var(--cb-wobble-y) * -1));
            }

            50% {
              transform: translate(calc(var(--cb-wobble-x) * -0.8), calc(var(--cb-wobble-y) * -0.25));
            }

            75% {
              transform: translate(calc(var(--cb-wobble-x) * 0.55), var(--cb-wobble-y));
            }

            100% {
              transform: translate(0, 0);
            }
          }

          @keyframes cb-coinflip-spin {
            0% {
              opacity: 0;
              transform: translate(-50%, -50%) rotateY(0deg) translateY(0) scale(0.78);
            }

            12% {
              opacity: 1;
            }

            100% {
              opacity: 1;
              transform: translate(-50%, -50%) rotateY(1440deg) translateY(0) scale(1.05);
            }
          }

          @keyframes cb-coinflip-result {
            0% {
              opacity: 0;
              transform: translate(-50%, -8px) scale(0.92);
            }

            10% {
              opacity: 1;
              transform: translate(-50%, 0) scale(1);
            }

            86% {
              opacity: 1;
              transform: translate(-50%, 0) scale(1);
            }

            100% {
              opacity: 0;
              transform: translate(-50%, 8px) scale(0.96);
            }
          }

          @keyframes cb-bottle-result {
            0% {
              opacity: 0;
              transform: translate(-50%, -4px) scale(0.95);
            }

            12% {
              opacity: 1;
              transform: translate(-50%, 0) scale(1);
            }

            82% {
              opacity: 1;
              transform: translate(-50%, 0) scale(1);
            }

            100% {
              opacity: 0;
              transform: translate(-50%, 8px) scale(0.96);
            }
          }

          @keyframes cb-bottle-spin {
            0% {
              transform: rotate(0deg);
            }

            100% {
              transform: rotate(var(--cb-bottle-rotation));
            }
          }

          @keyframes cb-bottle-winner {
            0% {
              background: white;
              border-color: rgb(212 212 216);
              transform: translate(-50%, -50%) scale(1);
            }

            100% {
              background: rgb(236 253 245);
              border-color: rgb(16 185 129);
              box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15);
              transform: translate(-50%, -50%) scale(1.05);
            }
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
              event.preventDefault();
              clearZoomHold();
              if (mode === "zoom") {
                return;
              }
              const point = getCanvasPoint(event);
              if (!point) {
                return;
              }

              const container = containerRef.current;
              const rect = container?.getBoundingClientRect();
              if (!rect) {
                return;
              }

              const menuWidth = 180;
              const menuHeight = 320;
              const x = clamp(event.clientX - rect.left, 8, Math.max(8, rect.width - menuWidth));
              const y = clamp(event.clientY - rect.top, 8, Math.max(8, rect.height - menuHeight));
              lastContextMenuPointRef.current = point;
              setContextMenuState({ x, y });
            }}
          />

          {bottleBursts.map((burst) => (
            <div key={burst.id} className="pointer-events-none absolute inset-0 z-[133] overflow-hidden">
              {burst.participants.map((participant) => {
                const angle = (participant.angle * Math.PI) / 180;
                const px = burst.x + Math.cos(angle) * 100;
                const py = burst.y + Math.sin(angle) * 100;
                const isSelected = participant.id === burst.selectedId;

                return (
                  <div
                    key={participant.id}
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-300 bg-white px-2 py-1 text-xs font-semibold shadow"
                    style={{
                      left: `${px}px`,
                      top: `${py}px`,
                      color: participant.color,
                      animation: isSelected
                        ? `cb-bottle-winner 320ms ease-out ${Math.round(burst.duration)}ms both`
                        : undefined,
                    }}
                  >
                    {participant.emoji} {participant.nickname}
                  </div>
                );
              })}

              <div
                className="absolute h-20 w-20 -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `${burst.x}px`,
                  top: `${burst.y}px`,
                  transform: "translate(-50%, -50%)",
                  transformOrigin: "center center",
                }}
              >
                <div
                  className="absolute inset-0"
                  style={{
                    ["--cb-bottle-rotation" as string]: `${burst.bottleRotation}deg`,
                    animation: `cb-bottle-spin ${burst.duration}ms cubic-bezier(0.14, 0.86, 0.2, 1) forwards`,
                    transformOrigin: "center center",
                  }}
                >
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-5xl">🍾</span>
                </div>
              </div>

              <div
                className="absolute whitespace-nowrap rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-semibold text-zinc-700 shadow"
                style={{
                  opacity: 0,
                  left: `${burst.x}px`,
                  top: `${burst.y + 126}px`,
                  animation: `cb-bottle-result 1.6s ease-out ${Math.round(burst.duration + 150)}ms both`,
                }}
              >
                🍾 Selected: {burst.participants.find((participant) => participant.id === burst.selectedId)?.emoji} {" "}
                {burst.participants.find((participant) => participant.id === burst.selectedId)?.nickname}
              </div>
            </div>
          ))}

          {coinflipBursts.map((flip) => (
            <div key={flip.id} className="pointer-events-none absolute inset-0 z-[132] overflow-hidden">
              <div
                className="absolute grid h-16 w-16 select-none place-items-center text-6xl leading-none"
                style={{
                  left: `${flip.x}px`,
                  top: `${flip.y}px`,
                  animation: "cb-coinflip-spin 1.25s ease-out forwards",
                  transformStyle: "preserve-3d",
                  perspective: "900px",
                  transformOrigin: "center center",
                }}
              >
                🪙
              </div>
              <div
                className={`absolute whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold shadow ${
                  flip.result === "Heads"
                    ? "border-amber-400 bg-amber-50 text-amber-700"
                    : "border-zinc-400 bg-zinc-100 text-zinc-700"
                }`}
                style={{
                  opacity: 0,
                  left: `${flip.x}px`,
                  top: `${flip.y + 26}px`,
                  animation: "cb-coinflip-result 2.15s ease-out 1.3s both",
                }}
              >
                {flip.result === "Heads" ? "👑 Heads" : "🦅 Tails"}
              </div>
            </div>
          ))}

          {sharknadoBursts.map((burst) => (
            <div
              key={burst.id}
              className="pointer-events-none absolute inset-0 z-[131] overflow-hidden"
              style={{
                ["--cb-wobble-x" as string]: `${burst.wobbleX}px`,
                ["--cb-wobble-y" as string]: `${burst.wobbleY}px`,
                animation: `cb-sharknado-wobble ${burst.wobbleDuration}ms ease-in-out infinite`,
              }}
            >
              <div
                className="absolute select-none text-6xl"
                style={{
                  left: `${burst.x}px`,
                  top: `${burst.y}px`,
                  animation: "cb-sharknado-core 1.35s ease-out forwards",
                }}
              >
                🌪️
              </div>
              {burst.sharks.map((shark) => (
                <span
                  key={shark.id}
                  className="absolute left-0 top-0 select-none text-xl"
                  style={{
                    opacity: 0,
                    left: `${burst.x}px`,
                    top: `${burst.y}px`,
                    ["--cb-lane" as string]: `${shark.lane}px`,
                    ["--cb-sway" as string]: `${shark.sway}px`,
                    ["--cb-start-scale" as string]: `${shark.startScale}`,
                    ["--cb-peak-scale" as string]: `${shark.peakScale}`,
                    ["--cb-end-scale" as string]: `${shark.endScale}`,
                    ["--cb-drift" as string]: `${shark.drift}px`,
                    animation: `cb-sharknado-spin ${shark.duration}ms linear ${shark.delay}ms both`,
                  }}
                >
                  🦈
                </span>
              ))}
              {burst.breakaways.map((shark) => (
                <span
                  key={shark.id}
                  className="absolute select-none text-2xl"
                  style={{
                    opacity: 0,
                    left: `${burst.x}px`,
                    top: `${burst.y}px`,
                    ["--cb-break-dx" as string]: `${shark.dx}px`,
                    ["--cb-break-dy" as string]: `${shark.dy}px`,
                    ["--cb-break-rot" as string]: `${shark.rotation}deg`,
                    ["--cb-break-scale" as string]: `${shark.scale}`,
                    animation: `cb-sharknado-breakaway ${shark.duration}ms ease-out ${shark.delay}ms both`,
                  }}
                >
                  🦈
                </span>
              ))}
            </div>
          ))}

          {confettiBursts.map((burst) => (
            <div key={burst.id} className="pointer-events-none absolute inset-0 z-[130] overflow-hidden">
              <div
                className="absolute select-none text-3xl"
                style={{
                  left: `${burst.x}px`,
                  top: `${burst.y}px`,
                  animation: "cb-confetti-pop 1.2s ease-out forwards",
                }}
              >
                🎉
              </div>
              {burst.pieces.map((piece) => (
                <span
                  key={piece.id}
                  className={`absolute h-2.5 w-1.5 rounded-sm ${piece.colorClass}`}
                  style={{
                    left: `${burst.x}px`,
                    top: `${burst.y}px`,
                    ["--cb-dx" as string]: `${piece.dx}px`,
                    ["--cb-dy" as string]: `${piece.dy}px`,
                    ["--cb-rot" as string]: `${piece.rotation}deg`,
                    animation: `cb-confetti-fall ${piece.duration}ms ease-out ${piece.delay}ms forwards`,
                  }}
                />
              ))}
            </div>
          ))}

          {contextMenuState ? (
            <div
              ref={contextMenuRef}
              className="absolute z-[140] w-44 rounded-md border border-zinc-300 bg-white p-1 shadow-lg"
              style={{
                left: `${contextMenuState.x}px`,
                top: `${contextMenuState.y}px`,
              }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  closeBoardContextMenu();
                  void cutSelectionToClipboard();
                }}
              >
                ✂️ Cut
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  closeBoardContextMenu();
                  void copySelectionToClipboard();
                }}
              >
                📋 Copy
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  closeBoardContextMenu();
                  void pasteImageFromClipboardOrMemory();
                }}
              >
                📥 Paste
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  closeBoardContextMenu();
                  uploadImageInputRef.current?.click();
                }}
              >
                🖼️ Upload an image
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  const popAt = contextMenuState;
                  closeBoardContextMenu();
                  if (popAt) {
                    launchConfetti(popAt.x + 18, popAt.y + 18);
                  }
                }}
              >
                🎉 Hooray
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  const popAt = contextMenuState;
                  closeBoardContextMenu();
                  if (popAt) {
                    launchSharknado(popAt.x + 18, popAt.y + 18);
                  }
                }}
              >
                🦈🌪️ Sharknado
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  const popAt = contextMenuState;
                  closeBoardContextMenu();
                  if (popAt) {
                    launchCoinflip(popAt.x + 18, popAt.y + 18);
                  }
                }}
              >
                🪙 Coinflip
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                onClick={() => {
                  const popAt = contextMenuState;
                  closeBoardContextMenu();
                  if (popAt) {
                    launchBottleSpin(popAt.x + 18, popAt.y + 18);
                  }
                }}
              >
                🍾 Bottle
              </button>
            </div>
          ) : null}

          <input
            ref={uploadImageInputRef}
            type="file"
            accept="image/*"
            onChange={onUploadImageInputChange}
            className="hidden"
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
