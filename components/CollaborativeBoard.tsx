"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { readStoredAccount, saveAccount, type CollBrushAccount } from "@/lib/account";
import type {
  BoardAction,
  BoardUser,
  CursorState,
  DrawMode,
  DrawSegment,
  FillAction,
  JoinBoardResponse,
  Point,
  ReplaceCanvasAction,
} from "@/lib/protocol";

type CollaborativeBoardProps = {
  boardId: string;
  userId: string;
  nickname: string;
};

type ToolMode = DrawMode | "bucket" | "select" | "picker";

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

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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
  const [account, setAccount] = useState<CollBrushAccount | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [selectionPreviewRect, setSelectionPreviewRect] = useState<SelectionRect | null>(null);

  const boardLink = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return `${window.location.origin}/board/${boardId}`;
  }, [boardId]);

  const getCanvasPoint = useCallback((event: PointerEvent | React.PointerEvent<HTMLCanvasElement>): Point | null => {
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
    setSelectionRect(null);
    setSelectionPreviewRect(null);
    movingBaseImageRef.current = null;
    movingSelectionImageRef.current = null;
  }, []);

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

    const nextAccount = saveAccount({
      userId: nextUserId,
      nickname: nextNickname,
    });

    setAccount(nextAccount);
  }, [nickname, router, userId]);

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
    if (!account) {
      return;
    }

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
      movingBaseImageRef.current = null;
      movingSelectionImageRef.current = null;
      applyReplaceActionToCanvas(replace);
    });

    socket.on("replace-canvas-preview", (replace: ReplaceCanvasAction) => {
      applyReplaceActionToCanvas(replace);
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
    account,
    applyBoardAction,
    applyReplaceActionToCanvas,
    boardId,
    handleClear,
    redrawFromActions,
    router,
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

    if (mode === "select") {
      pointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);

      if (selectionRect && pointInRect(point, selectionRect)) {
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }

        movingRef.current = true;
        moveOffsetRef.current = {
          x: point.x - selectionRect.x,
          y: point.y - selectionRect.y,
        };

        const fullImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const baseData = new Uint8ClampedArray(fullImage.data);
        for (let y = selectionRect.y; y < selectionRect.y + selectionRect.height; y += 1) {
          for (let x = selectionRect.x; x < selectionRect.x + selectionRect.width; x += 1) {
            const index = (y * canvas.width + x) * 4;
            baseData[index] = 0;
            baseData[index + 1] = 0;
            baseData[index + 2] = 0;
            baseData[index + 3] = 0;
          }
        }

        movingBaseImageRef.current = new ImageData(baseData, canvas.width, canvas.height);
        movingSelectionImageRef.current = ctx.getImageData(
          selectionRect.x,
          selectionRect.y,
          selectionRect.width,
          selectionRect.height,
        );

        selectionMoveStartSnapshotRef.current = canvas.toDataURL("image/png");
        setSelectionPreviewRect(selectionRect);
        return;
      }

      selectingRef.current = true;
      selectionStartRef.current = point;
      const nextRect = normalizeRect(point, point);
      setSelectionRect(nextRect);
      setSelectionPreviewRect(nextRect);
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

    if (mode === "select") {
      if (pointerIdRef.current !== event.pointerId) {
        return;
      }

      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }

      if (selectingRef.current && selectionStartRef.current) {
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
    if (mode === "select") {
      if (event && pointerIdRef.current === event.pointerId) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (selectingRef.current) {
        selectingRef.current = false;
        const rect = selectionPreviewRect;
        if (!rect || rect.width < 2 || rect.height < 2) {
          setSelectionRect(null);
          setSelectionPreviewRect(null);
        } else {
          setSelectionRect(rect);
        }
      }

      if (movingRef.current) {
        movingRef.current = false;
        const target = selectionPreviewRect;
        if (target) {
          setSelectionRect(target);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }

      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      const lowerKey = event.key.toLowerCase();

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
    commitCanvasSnapshot,
    getCanvasSnapshot,
    pushHistoryEntry,
    selectionRect,
  ]);

  const displayedSelection = selectionPreviewRect ?? selectionRect;

  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-100 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
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
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "draw" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              ✏️ Pen
            </button>
            <button
              type="button"
              onClick={() => setMode("erase")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "erase" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🧽 Eraser
            </button>
            <button
              type="button"
              onClick={() => setMode("bucket")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "bucket" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🪣 Bucket
            </button>
            <button
              type="button"
              onClick={() => setMode("select")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "select" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🔲 Select
            </button>
            <button
              type="button"
              onClick={() => setMode("picker")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "picker" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              🎨 Picker
            </button>

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
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <span>{isConnected ? "Connected" : "Connecting..."}</span>
          {joinError ? <span className="font-medium text-red-600">{joinError}</span> : null}
        </div>

        <div ref={containerRef} className="relative min-h-[60vh] flex-1 overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-sm">
          <canvas
            ref={canvasRef}
            className="h-full w-full touch-none"
            onPointerDown={startDrawing}
            onPointerMove={continueDrawing}
            onPointerUp={stopDrawing}
            onPointerLeave={stopDrawing}
            onPointerCancel={stopDrawing}
            onPointerEnter={emitCursorOnEnter}
          />

          {displayedSelection ? (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-blue-500 bg-blue-200/20"
              style={{
                left: `${(displayedSelection.x / (canvasRef.current?.width || 1)) * 100}%`,
                top: `${(displayedSelection.y / (canvasRef.current?.height || 1)) * 100}%`,
                width: `${(displayedSelection.width / (canvasRef.current?.width || 1)) * 100}%`,
                height: `${(displayedSelection.height / (canvasRef.current?.height || 1)) * 100}%`,
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
      </main>
    </div>
  );
}
