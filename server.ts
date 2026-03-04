import { createServer } from "node:http";
import next from "next";
import { Server as IOServer } from "socket.io";
import type { DrawSegment, JoinBoardResponse } from "./lib/protocol";

const dev = process.env.NODE_ENV !== "production";
const host = "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

type BoardState = {
  users: Set<string>;
  segments: DrawSegment[];
};

const MAX_USERS_PER_BOARD = 10;
const MAX_SEGMENTS_PER_BOARD = 20000;

const boards = new Map<string, BoardState>();

const getBoard = (boardId: string): BoardState => {
  const existing = boards.get(boardId);
  if (existing) {
    return existing;
  }

  const created: BoardState = {
    users: new Set<string>(),
    segments: [],
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
      io.to(currentBoardId).emit("presence", { usersCount: board.users.size });
      socket.data.boardId = undefined;

      cleanupBoardIfEmpty(currentBoardId);
    };

    socket.on("join-board", (boardIdRaw: string, callback: (response: JoinBoardResponse) => void) => {
      const boardId = (boardIdRaw ?? "").trim().slice(0, 80);

      if (!boardId) {
        callback({
          ok: false,
          reason: "Board ID is required.",
        });
        return;
      }

      leaveCurrentBoard();

      const board = getBoard(boardId);
      if (board.users.size >= MAX_USERS_PER_BOARD) {
        callback({
          ok: false,
          reason: `Board is full (max ${MAX_USERS_PER_BOARD} users).`,
        });
        return;
      }

      board.users.add(socket.id);
      socket.join(boardId);
      socket.data.boardId = boardId;

      callback({
        ok: true,
        segments: board.segments,
        usersCount: board.users.size,
      });

      io.to(boardId).emit("presence", { usersCount: board.users.size });
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

      board.segments.push(segment);
      if (board.segments.length > MAX_SEGMENTS_PER_BOARD) {
        board.segments.splice(0, board.segments.length - MAX_SEGMENTS_PER_BOARD);
      }

      socket.to(boardId).emit("draw-segment", segment);
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

      board.segments = [];
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
