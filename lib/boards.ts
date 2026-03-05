export type StoredBoard = {
  id: string;
  name: string;
  updatedAt: number;
  previewDataUrl?: string;
};

const clampText = (value: string, max: number) => value.trim().slice(0, max);

const getBoardsStorageKey = (userId: string) => `collbrush_boards_${clampText(userId, 80)}`;

export const readStoredBoards = (userId: string): StoredBoard[] => {
  if (typeof window === "undefined") {
    return [];
  }

  const safeUserId = clampText(userId, 80);
  if (!safeUserId) {
    return [];
  }

  const raw = window.localStorage.getItem(getBoardsStorageKey(safeUserId));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Array<Partial<StoredBoard>>;
    const normalized = parsed
      .map((board) => {
        const id = clampText(board.id ?? "", 80);
        if (!id) {
          return null;
        }

        return {
          id,
          name: clampText(board.name ?? "", 80) || id,
          updatedAt: Number(board.updatedAt) || Date.now(),
          previewDataUrl:
            typeof board.previewDataUrl === "string" && board.previewDataUrl.startsWith("data:image")
              ? board.previewDataUrl
              : undefined,
        } satisfies StoredBoard;
      })
      .filter((board) => board !== null) as StoredBoard[];

    return normalized.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
};

export const saveStoredBoards = (userId: string, boards: StoredBoard[]) => {
  if (typeof window === "undefined") {
    return;
  }

  const safeUserId = clampText(userId, 80);
  if (!safeUserId) {
    return;
  }

  const normalized = boards
    .map((board) => ({
      id: clampText(board.id, 80),
      name: clampText(board.name, 80) || clampText(board.id, 80),
      updatedAt: Number(board.updatedAt) || Date.now(),
      previewDataUrl:
        typeof board.previewDataUrl === "string" && board.previewDataUrl.startsWith("data:image")
          ? board.previewDataUrl
          : undefined,
    }))
    .filter((board) => board.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);

  window.localStorage.setItem(getBoardsStorageKey(safeUserId), JSON.stringify(normalized));
};

export const upsertStoredBoard = (
  userId: string,
  board: { id: string; name?: string; previewDataUrl?: string },
): StoredBoard[] => {
  const current = readStoredBoards(userId);
  const safeId = clampText(board.id, 80);
  if (!safeId) {
    return current;
  }

  const previous = current.find((item) => item.id === safeId);
  const nextBoard: StoredBoard = {
    id: safeId,
    name: clampText(board.name ?? "", 80) || previous?.name || safeId,
    previewDataUrl:
      typeof board.previewDataUrl === "string" && board.previewDataUrl.startsWith("data:image")
        ? board.previewDataUrl
        : previous?.previewDataUrl,
    updatedAt: Date.now(),
  };

  const nextBoards = [nextBoard, ...current.filter((item) => item.id !== safeId)].slice(0, 5);
  saveStoredBoards(userId, nextBoards);
  return nextBoards;
};

export const renameStoredBoard = (userId: string, boardId: string, name: string): StoredBoard[] => {
  const safeBoardId = clampText(boardId, 80);
  const safeName = clampText(name, 80);
  const current = readStoredBoards(userId);
  const next = current.map((board) =>
    board.id === safeBoardId
      ? {
          ...board,
          name: safeName || board.id,
          updatedAt: Date.now(),
        }
      : board,
  );
  saveStoredBoards(userId, next);
  return readStoredBoards(userId);
};

export const removeStoredBoard = (userId: string, boardId: string): StoredBoard[] => {
  const safeBoardId = clampText(boardId, 80);
  const current = readStoredBoards(userId);
  const next = current.filter((board) => board.id !== safeBoardId);
  saveStoredBoards(userId, next);
  return next;
};
