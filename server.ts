import { createServer } from "node:http";
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

const MAX_USERS_PER_BOARD = 10;
const MAX_ACTIONS_PER_BOARD = 25000;

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

  if (board.users.size === 0) {
    boards.delete(boardId);
  }
};

void app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
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
      if (board.users.size >= MAX_USERS_PER_BOARD) {
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
      io.to(boardId).emit("clear-board");
    });

    socket.on("disconnect", () => {
      leaveCurrentBoard();
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
