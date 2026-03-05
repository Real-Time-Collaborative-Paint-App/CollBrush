import { describe, expect, it } from "vitest";
import type { BoardObject, BoardUser, DrawSegment, FillAction, ReplaceCanvasAction } from "./protocol";
import {
  MAX_USERS_PER_BOARD,
  buildPresenceSnapshot,
  type BoardRuntimeState,
  canUserJoinBoard,
  parsePersistedBoards,
  shouldFlushAfterLeave,
  serializeBoardsForPersistence,
} from "./server-utils";

describe("board user limit", () => {
  it("allows users below the max and rejects user 11", () => {
    expect(canUserJoinBoard(0, MAX_USERS_PER_BOARD)).toBe(true);
    expect(canUserJoinBoard(9, MAX_USERS_PER_BOARD)).toBe(true);
    expect(canUserJoinBoard(10, MAX_USERS_PER_BOARD)).toBe(false);
  });
});

describe("progress persistence between sessions", () => {
  it("serializes and restores non-empty board state", () => {
    const segment: DrawSegment = {
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      color: "#111111",
      size: 4,
      mode: "draw",
    };

    const fill: FillAction = {
      point: { x: 5, y: 6 },
      color: "#22aa44",
    };

    const replace: ReplaceCanvasAction = {
      dataUrl: "data:image/png;base64,abc",
    };

    const object: BoardObject = {
      id: "obj-1",
      type: "text",
      x: 10,
      y: 20,
      width: 120,
      height: 60,
      rotation: 0,
      flipX: false,
      flipY: false,
      content: "hello",
      style: {
        fontFamily: "Arial",
        fontSize: 24,
        color: "#111827",
        bold: false,
        italic: false,
        strikethrough: false,
        spoiler: false,
      },
    };

    const boards: Map<string, BoardRuntimeState> = new Map([
      [
        "board-a",
        {
          actions: [
            { type: "segment", segment },
            { type: "fill", fill },
            { type: "replace", replace },
          ],
          objects: new Map([[object.id, object]]),
        },
      ],
      [
        "board-empty",
        {
          actions: [],
          objects: new Map(),
        },
      ],
    ]);

    const serialized = serializeBoardsForPersistence(boards);
    expect(Object.keys(serialized)).toEqual(["board-a"]);

    const restored = parsePersistedBoards(serialized);
    const restoredBoard = restored.get("board-a");
    expect(restoredBoard).toBeDefined();
    expect(restoredBoard?.actions.length).toBe(3);
    expect(restoredBoard?.objects.get(object.id)?.content).toBe("hello");
  });
});

describe("active users presence snapshot", () => {
  it("returns currently active users for requested board IDs", () => {
    const userA: BoardUser = {
      socketId: "s-1",
      userId: "u-1",
      nickname: "Alice",
      animalEmoji: "🐱",
      cursorColor: "#2563eb",
    };

    const userB: BoardUser = {
      socketId: "s-2",
      userId: "u-2",
      nickname: "Bob",
      animalEmoji: "🐶",
      cursorColor: "#ef4444",
    };

    const boards = new Map([
      [
        "board-live",
        {
          users: new Map([
            [userA.socketId, userA],
            [userB.socketId, userB],
          ]),
        },
      ],
    ]);

    const presence = buildPresenceSnapshot(boards, ["board-live"]);
    expect(presence["board-live"]?.usersCount).toBe(2);
    expect(presence["board-live"]?.users.map((user) => user.nickname)).toEqual(["Alice", "Bob"]);
  });
});

describe("flush after leave", () => {
  it("flushes when the last user leaves", () => {
    expect(shouldFlushAfterLeave(0)).toBe(true);
    expect(shouldFlushAfterLeave(1)).toBe(false);
  });
});
