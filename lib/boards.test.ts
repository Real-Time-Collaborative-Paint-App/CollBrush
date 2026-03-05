import { beforeEach, describe, expect, it } from "vitest";
import {
  readStoredBoards,
  saveStoredBoards,
  upsertStoredBoard,
  type StoredBoard,
} from "./boards";

class LocalStorageMock {
  private store = new Map<string, string>();

  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

const userId = "tester";

beforeEach(() => {
  const localStorage = new LocalStorageMock();
  (globalThis as unknown as { window: Window & { localStorage: LocalStorageMock } }).window = {
    localStorage,
  } as Window & { localStorage: LocalStorageMock };
});

describe("my boards max size", () => {
  it("keeps only 5 boards when saving a full list", () => {
    const manyBoards: StoredBoard[] = Array.from({ length: 8 }, (_, index) => ({
      id: `board-${index + 1}`,
      name: `Board ${index + 1}`,
      updatedAt: Date.now() + index,
      previewDataUrl: undefined,
    }));

    saveStoredBoards(userId, manyBoards);
    const stored = readStoredBoards(userId);

    expect(stored).toHaveLength(5);
  });

  it("keeps list at 5 when adding more boards over time", () => {
    for (let index = 0; index < 7; index += 1) {
      upsertStoredBoard(userId, {
        id: `board-${index + 1}`,
        name: `Board ${index + 1}`,
      });
    }

    const stored = readStoredBoards(userId);
    expect(stored).toHaveLength(5);
    expect(stored[0]?.id).toBe("board-7");
  });
});
