import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import next from "next";
import { Server as IOServer } from "socket.io";
import type {
  BoardAction,
  BoardObject,
  BoardUser,
  CursorMovePayload,
  CursorState,
  FillAction,
  ReplaceCanvasAction,
  DrawSegment,
  JoinBoardRequest,
  JoinBoardResponse,
} from "./lib/protocol";
import {
  MAX_USERS_PER_BOARD,
  buildPresenceSnapshot,
  canUserJoinBoard,
  parsePersistedBoards,
  serializeBoardsForPersistence,
  shouldFlushAfterLeave,
  type PersistedBoardsFile,
} from "./lib/server-utils";

const dev = process.env.NODE_ENV !== "production";
const host = "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

type BoardState = {
  users: Map<string, BoardUser>;
  actions: BoardAction[];
  objects: Map<string, BoardObject>;
};

const MAX_ACTIONS_PER_BOARD = 25000;
const PERSISTENCE_DIR = path.join(process.cwd(), ".data");
const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, "boards.json");
const PERSISTENCE_TEMP_FILE = path.join(PERSISTENCE_DIR, "boards.json.tmp");
const PERSISTENCE_BACKUP_FILE = path.join(PERSISTENCE_DIR, "boards.json.bak");

const CURSOR_COLORS = [
  "#2563eb",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
  "#f97316",
  "#14b8a6",
];

const ANIMAL_EMOJIS = ["🐶", "🐱", "🐰", "🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐧", "🦉", "🦄"];

const pickRandom = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

const boards = new Map<string, BoardState>();

let persistTimeout: NodeJS.Timeout | null = null;
let persistenceWriteChain: Promise<void> = Promise.resolve();

const serializeBoards = (): PersistedBoardsFile => {
  const persistenceBoards = new Map(
    Array.from(boards.entries()).map(([boardId, board]) => [
      boardId,
      {
        actions: board.actions,
        objects: board.objects,
      },
    ]),
  );
  return serializeBoardsForPersistence(persistenceBoards);
};

const persistBoardsNow = async () => {
  const payload = JSON.stringify(serializeBoards());
  await fs.mkdir(PERSISTENCE_DIR, { recursive: true });
  await fs.writeFile(PERSISTENCE_TEMP_FILE, payload, "utf8");

  try {
    await fs.rename(PERSISTENCE_TEMP_FILE, PERSISTENCE_FILE);
    await fs.writeFile(PERSISTENCE_BACKUP_FILE, payload, "utf8");
    return;
  } catch (error) {
    console.warn("Atomic board persistence rename failed, using direct write fallback:", error);
  }

  await fs.writeFile(PERSISTENCE_FILE, payload, "utf8");
  await fs.writeFile(PERSISTENCE_BACKUP_FILE, payload, "utf8");

  try {
    await fs.unlink(PERSISTENCE_TEMP_FILE);
  } catch (unlinkError) {
    const unlinkNodeError = unlinkError as NodeJS.ErrnoException;
    if (unlinkNodeError.code !== "ENOENT") {
      console.warn("Failed to remove temp persistence file:", unlinkError);
    }
  }
};

const queuePersistBoardsNow = () => {
  persistenceWriteChain = persistenceWriteChain
    .then(async () => {
      await persistBoardsNow();
    })
    .catch((error) => {
      console.error("Failed to persist boards:", error);
    });

  return persistenceWriteChain;
};

const schedulePersistBoards = () => {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
  }

  persistTimeout = setTimeout(() => {
    persistTimeout = null;
    void queuePersistBoardsNow();
  }, 250);
};

const flushPersistBoards = async () => {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
    persistTimeout = null;
  }

  await queuePersistBoardsNow();
};

const loadPersistedBoards = async () => {
  const applyParsedBoards = (parsed: PersistedBoardsFile) => {
    const loadedBoards = parsePersistedBoards(parsed);
    for (const [boardId, board] of loadedBoards.entries()) {
      boards.set(boardId, {
        users: new Map<string, BoardUser>(),
        actions: board.actions,
        objects: board.objects,
      });
    }
  };

  try {
    const raw = await fs.readFile(PERSISTENCE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedBoardsFile;
    applyParsedBoards(parsed);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") {
      return;
    }

    try {
      const fallbackRaw = await fs.readFile(PERSISTENCE_TEMP_FILE, "utf8");
      const parsed = JSON.parse(fallbackRaw) as PersistedBoardsFile;
      applyParsedBoards(parsed);
    } catch (tempError) {
      try {
        const backupRaw = await fs.readFile(PERSISTENCE_BACKUP_FILE, "utf8");
        const parsed = JSON.parse(backupRaw) as PersistedBoardsFile;
        applyParsedBoards(parsed);
      } catch {
        console.error("Failed to load persisted boards:", error, tempError);
      }
    }
  }
};

const getBoard = (boardId: string): BoardState => {
  const existing = boards.get(boardId);
  if (existing) {
    return existing;
  }

  const created: BoardState = {
    users: new Map<string, BoardUser>(),
    actions: [],
    objects: new Map<string, BoardObject>(),
  };

  boards.set(boardId, created);
  return created;
};

const cleanupBoardIfEmpty = (boardId: string) => {
  const board = boards.get(boardId);
  if (!board) {
    return;
  }
};

void app.prepare().then(async () => {
  await loadPersistedBoards();

  const httpServer = createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const requestUrl = req.url ?? "/";
    const url = new URL(requestUrl, `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/board-presence") {
      const requestOrigin = req.headers.origin;
      res.setHeader("Access-Control-Allow-Origin", requestOrigin || "*");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
    }

    if (method === "GET" && url.pathname === "/api/board-presence") {
      const rawIds = url.searchParams.getAll("boardId");
      const presence = buildPresenceSnapshot(boards, rawIds);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ presence }));
      return;
    }

    handle(req, res);
  });

  const io = new IOServer(httpServer, {
    path: "/socket.io",
    cors: {
      origin: "*",
    },
  });

  io.on("connection", (socket) => {
    const emitPresence = (boardId: string) => {
      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      const users = Array.from(board.users.values());
      io.to(boardId).emit("presence", {
        usersCount: users.length,
        users,
      });
    };

    const leaveCurrentBoard = () => {
      const currentBoardId = socket.data.boardId as string | undefined;
      if (!currentBoardId) {
        return;
      }

      const board = boards.get(currentBoardId);
      if (!board) {
        socket.data.boardId = undefined;
        return;
      }

      board.users.delete(socket.id);
      socket.leave(currentBoardId);
      socket.to(currentBoardId).emit("cursor-leave", { socketId: socket.id });
      emitPresence(currentBoardId);
      socket.data.boardId = undefined;
      socket.data.user = undefined;

      if (shouldFlushAfterLeave(board.users.size)) {
        void flushPersistBoards();
      }

      cleanupBoardIfEmpty(currentBoardId);
    };

    socket.on("join-board", (request: JoinBoardRequest, callback: (response: JoinBoardResponse) => void) => {
      const boardId = (request.boardId ?? "").trim().slice(0, 80);
      const userId = (request.userId ?? "").trim().slice(0, 80);
      const nickname = (request.nickname ?? "").trim().slice(0, 40);

      if (!boardId) {
        callback({
          ok: false,
          reason: "Board ID is required.",
          code: "INVALID_BOARD",
        });
        return;
      }

      if (!userId || !nickname) {
        callback({
          ok: false,
          reason: "User info is required.",
          code: "INVALID_USER",
        });
        return;
      }

      leaveCurrentBoard();

      const board = getBoard(boardId);
      if (!canUserJoinBoard(board.users.size, MAX_USERS_PER_BOARD)) {
        callback({
          ok: false,
          reason: "This Board is full",
          code: "BOARD_FULL",
        });
        return;
      }

      const user: BoardUser = {
        socketId: socket.id,
        userId,
        nickname,
        cursorColor: pickRandom(CURSOR_COLORS),
        animalEmoji: pickRandom(ANIMAL_EMOJIS),
      };

      board.users.set(socket.id, user);
      socket.join(boardId);
      socket.data.boardId = boardId;
      socket.data.user = user;

      const users = Array.from(board.users.values());

      callback({
        ok: true,
        actions: board.actions,
        objects: Array.from(board.objects.values()),
        usersCount: users.length,
        users,
      });

      emitPresence(boardId);
    });

    socket.on("draw-segment", (segment: DrawSegment) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      board.actions.push({
        type: "segment",
        segment,
      });
      if (board.actions.length > MAX_ACTIONS_PER_BOARD) {
        board.actions.splice(0, board.actions.length - MAX_ACTIONS_PER_BOARD);
      }

      schedulePersistBoards();

      socket.to(boardId).emit("draw-segment", segment);
    });

    socket.on("fill-area", (fill: FillAction) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      board.actions.push({
        type: "fill",
        fill,
      });
      if (board.actions.length > MAX_ACTIONS_PER_BOARD) {
        board.actions.splice(0, board.actions.length - MAX_ACTIONS_PER_BOARD);
      }

      schedulePersistBoards();

      socket.to(boardId).emit("fill-area", fill);
    });

    socket.on("replace-canvas", (replace: ReplaceCanvasAction) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      board.actions = [
        {
          type: "replace",
          replace,
        },
      ];

      schedulePersistBoards();

      socket.to(boardId).emit("replace-canvas", replace);
    });

    socket.on("replace-canvas-preview", (replace: ReplaceCanvasAction) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      if (!boards.has(boardId)) {
        return;
      }

      socket.to(boardId).emit("replace-canvas-preview", replace);
    });

    socket.on("upsert-object", (object: BoardObject) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      board.objects.set(object.id, object);
      schedulePersistBoards();
      socket.to(boardId).emit("upsert-object", object);
    });

    socket.on("remove-object", ({ id }: { id: string }) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      board.objects.delete(id);
      schedulePersistBoards();
      socket.to(boardId).emit("remove-object", { id });
    });

    socket.on("cursor-move", (payload: CursorMovePayload) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      const user = board.users.get(socket.id);
      if (!user) {
        return;
      }

      const x = Number.isFinite(payload.x) ? Math.min(1, Math.max(0, payload.x)) : 0;
      const y = Number.isFinite(payload.y) ? Math.min(1, Math.max(0, payload.y)) : 0;

      const cursorState: CursorState = {
        ...user,
        x,
        y,
      };

      socket.to(boardId).emit("cursor-move", cursorState);
    });

    socket.on("clear-board", () => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) {
        return;
      }

      const board = boards.get(boardId);
      if (!board) {
        return;
      }

      board.actions = [];
      board.objects.clear();
      schedulePersistBoards();
      io.to(boardId).emit("clear-board");
    });

    socket.on("disconnect", () => {
      leaveCurrentBoard();
      void flushPersistBoards();
    });
  });

  process.on("SIGINT", () => {
    void flushPersistBoards().finally(() => {
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    void flushPersistBoards().finally(() => {
      process.exit(0);
    });
  });

  httpServer
    .once("error", (error) => {
      console.error(error);
      process.exit(1);
    })
    .listen(port, host, () => {
      console.log(`> Ready on http://${host}:${port}`);
    });
});
