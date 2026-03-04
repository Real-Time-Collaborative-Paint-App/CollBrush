"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { readStoredAccount, saveAccount, type CollBrushAccount } from "@/lib/account";
import type {
  BoardUser,
  CursorState,
  DrawMode,
  DrawSegment,
  JoinBoardResponse,
  Point,
} from "@/lib/protocol";

type CollaborativeBoardProps = {
  boardId: string;
  userId: string;
  nickname: string;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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

export default function CollaborativeBoard({ boardId, userId, nickname }: CollaborativeBoardProps) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const segmentsRef = useRef<DrawSegment[]>([]);
  const lastCursorEmitRef = useRef(0);

  const isDrawingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const previousPointRef = useRef<Point | null>(null);

  const [usersCount, setUsersCount] = useState(1);
  const [boardUsers, setBoardUsers] = useState<BoardUser[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<Record<string, CursorState>>({});
  const [color, setColor] = useState("#111827");
  const [brushSize, setBrushSize] = useState(4);
  const [mode, setMode] = useState<DrawMode>("draw");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [account, setAccount] = useState<CollBrushAccount | null>(null);

  const boardLink = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return `${window.location.origin}/board/${boardId}`;
  }, [boardId]);

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

  const redrawFromSegments = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const segment of segmentsRef.current) {
      drawSegmentOnContext(ctx, segment);
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
    redrawFromSegments();
  }, [redrawFromSegments]);

  const applySegment = useCallback((segment: DrawSegment, pushToState: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    drawSegmentOnContext(ctx, segment);

    if (pushToState) {
      segmentsRef.current.push(segment);
    }
  }, []);

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    segmentsRef.current = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
        segmentsRef.current = response.segments;
        redrawFromSegments();
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
      applySegment(segment, true);
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
  }, [account, applySegment, boardId, handleClear, redrawFromSegments, router]);

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

    isDrawingRef.current = true;
    pointerIdRef.current = event.pointerId;
    previousPointRef.current = point;
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
      mode,
    };

    applySegment(segment, true);
    socketRef.current?.emit("draw-segment", segment);

    previousPointRef.current = currentPoint;
  };

  const stopDrawing = (event?: React.PointerEvent<HTMLCanvasElement>) => {
    if (event && pointerIdRef.current === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    isDrawingRef.current = false;
    pointerIdRef.current = null;
    previousPointRef.current = null;
  };

  const clearBoard = () => {
    handleClear();
    socketRef.current?.emit("clear-board");
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
              Pen
            </button>
            <button
              type="button"
              onClick={() => setMode("erase")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                mode === "erase" ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300"
              }`}
            >
              Eraser
            </button>

            <div className="mx-1 h-6 w-px bg-zinc-300" />

            <label className="flex items-center gap-2 text-sm text-zinc-600">
              Color
              <input
                type="color"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                  setMode("draw");
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
              Clear
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
              Copy link
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
