import type { BoardAction, BoardObject, BoardUser } from "./protocol";

export type BoardRuntimeState = {
  actions: BoardAction[];
  objects: Map<string, BoardObject>;
};

export type PersistedBoardState = {
  actions: BoardAction[];
  objects: BoardObject[];
};

export type PersistedBoardsFile = Record<string, PersistedBoardState>;

export type PresenceBoardState = {
  users: Map<string, BoardUser>;
};

export type PresenceSnapshot = Record<
  string,
  {
    usersCount: number;
    users: Array<{
      userId: string;
      nickname: string;
      animalEmoji: string;
      cursorColor: string;
    }>;
  }
>;

export const MAX_USERS_PER_BOARD = 10;

export const canUserJoinBoard = (
  usersCount: number,
  maxUsers: number = MAX_USERS_PER_BOARD,
) => usersCount < maxUsers;

export const serializeBoardsForPersistence = (
  boards: Map<string, BoardRuntimeState>,
): PersistedBoardsFile => {
  const serialized: PersistedBoardsFile = {};

  for (const [boardId, board] of boards.entries()) {
    if (board.actions.length === 0 && board.objects.size === 0) {
      continue;
    }

    serialized[boardId] = {
      actions: board.actions,
      objects: Array.from(board.objects.values()),
    };
  }

  return serialized;
};

export const parsePersistedBoards = (parsed: PersistedBoardsFile) => {
  const result = new Map<string, BoardRuntimeState>();

  for (const [boardId, persistedBoard] of Object.entries(parsed)) {
    const safeBoardId = boardId.trim().slice(0, 80);
    if (!safeBoardId) {
      continue;
    }

    result.set(safeBoardId, {
      actions: Array.isArray(persistedBoard.actions) ? persistedBoard.actions : [],
      objects: new Map(
        (Array.isArray(persistedBoard.objects) ? persistedBoard.objects : [])
          .filter((object) => typeof object?.id === "string" && object.id.trim())
          .map((object) => [object.id, object] as const),
      ),
    });
  }

  return result;
};

export const buildPresenceSnapshot = (
  boards: Map<string, PresenceBoardState>,
  boardIds: string[],
): PresenceSnapshot => {
  const normalizedIds = Array.from(
    new Set(
      boardIds
        .map((id) => id.trim().slice(0, 80))
        .filter((id) => id.length > 0)
        .slice(0, 50),
    ),
  );

  return Object.fromEntries(
    normalizedIds.map((boardId) => {
      const board = boards.get(boardId);
      const users = board ? Array.from(board.users.values()) : [];
      return [
        boardId,
        {
          usersCount: users.length,
          users: users.map((user) => ({
            userId: user.userId,
            nickname: user.nickname,
            animalEmoji: user.animalEmoji,
            cursorColor: user.cursorColor,
          })),
        },
      ];
    }),
  );
};

export const shouldFlushAfterLeave = (usersCount: number) => usersCount === 0;
