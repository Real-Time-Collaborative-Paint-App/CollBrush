import { describe, expect, it } from "vitest";
import {
  buildBoardPresenceQuery,
  mergeBoardPresenceWithLocal,
  removeLocalBoardPresence,
  upsertLocalBoardPresence,
} from "./board-presence";

describe("board presence query builder", () => {
  it("builds encoded boardId query params", () => {
    const query = buildBoardPresenceQuery(["board-1", "room with space", "привет"]);
    expect(query).toBe(
      "boardId=board-1&boardId=room%20with%20space&boardId=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82",
    );
  });
});

describe("board presence local fallback", () => {
  it("merges local heartbeat presence with remote data", () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window: Window & { localStorage: Storage } }).window = {
      localStorage: {
        getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
        key: () => null,
        length: 0,
      },
    } as Window & { localStorage: Storage };

    upsertLocalBoardPresence("board-1", {
      userId: "user-1",
      nickname: "Alice",
      animalEmoji: "🐱",
      cursorColor: "#2563eb",
    });

    const merged = mergeBoardPresenceWithLocal(["board-1"], {});
    expect(merged["board-1"]?.usersCount).toBe(1);
    expect(merged["board-1"]?.users[0]?.nickname).toBe("Alice");

    removeLocalBoardPresence("board-1", "user-1");
    const afterRemove = mergeBoardPresenceWithLocal(["board-1"], {});
    expect(afterRemove["board-1"]?.usersCount).toBe(0);
  });
});
