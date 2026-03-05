import { buildBackendUrl } from "./runtime-config";

export type ActiveBoardUser = {
  userId: string;
  nickname: string;
  animalEmoji: string;
  cursorColor: string;
};

export type BoardPresence = {
  usersCount: number;
  users: ActiveBoardUser[];
};

type LocalPresenceEntry = ActiveBoardUser & {
  expiresAt: number;
};

type LocalPresenceStore = Record<string, LocalPresenceEntry[]>;

const LOCAL_PRESENCE_KEY = "collbrush_local_presence";
const LOCAL_PRESENCE_TTL_MS = 8000;

const readLocalPresenceStore = (): LocalPresenceStore => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_PRESENCE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as LocalPresenceStore;
    return parsed ?? {};
  } catch {
    return {};
  }
};

const writeLocalPresenceStore = (store: LocalPresenceStore) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(LOCAL_PRESENCE_KEY, JSON.stringify(store));
};

const pruneExpiredLocalPresence = (store: LocalPresenceStore) => {
  const now = Date.now();
  const nextStore: LocalPresenceStore = {};

  for (const [boardId, users] of Object.entries(store)) {
    const validUsers = users.filter((user) => user.expiresAt > now);
    if (validUsers.length > 0) {
      nextStore[boardId] = validUsers;
    }
  }

  return nextStore;
};

export const upsertLocalBoardPresence = (boardId: string, user: ActiveBoardUser) => {
  const safeBoardId = boardId.trim().slice(0, 80);
  if (!safeBoardId) {
    return;
  }

  const store = pruneExpiredLocalPresence(readLocalPresenceStore());
  const users = store[safeBoardId] ?? [];
  const nextEntry: LocalPresenceEntry = {
    ...user,
    expiresAt: Date.now() + LOCAL_PRESENCE_TTL_MS,
  };

  store[safeBoardId] = [nextEntry, ...users.filter((existing) => existing.userId !== user.userId)];
  writeLocalPresenceStore(store);
};

export const removeLocalBoardPresence = (boardId: string, userId: string) => {
  const safeBoardId = boardId.trim().slice(0, 80);
  const safeUserId = userId.trim().slice(0, 80);
  if (!safeBoardId || !safeUserId) {
    return;
  }

  const store = pruneExpiredLocalPresence(readLocalPresenceStore());
  const users = store[safeBoardId] ?? [];
  const nextUsers = users.filter((entry) => entry.userId !== safeUserId);
  if (nextUsers.length > 0) {
    store[safeBoardId] = nextUsers;
  } else {
    delete store[safeBoardId];
  }

  writeLocalPresenceStore(store);
};

export const mergeBoardPresenceWithLocal = (
  boardIds: string[],
  remotePresence: Record<string, BoardPresence>,
): Record<string, BoardPresence> => {
  const store = pruneExpiredLocalPresence(readLocalPresenceStore());
  writeLocalPresenceStore(store);

  return Object.fromEntries(
    boardIds.map((boardId) => {
      const remote = remotePresence[boardId] ?? { usersCount: 0, users: [] };
      const localUsers = (store[boardId] ?? []).map((entry) => ({
        userId: entry.userId,
        nickname: entry.nickname,
        animalEmoji: entry.animalEmoji,
        cursorColor: entry.cursorColor,
      }));
      const usersById = new Map<string, ActiveBoardUser>();

      for (const user of [...remote.users, ...localUsers]) {
        usersById.set(user.userId, user);
      }

      const users = Array.from(usersById.values());
      return [
        boardId,
        {
          usersCount: users.length,
          users,
        },
      ];
    }),
  );
};

export const buildBoardPresenceQuery = (boardIds: string[]) =>
  boardIds.map((boardId) => `boardId=${encodeURIComponent(boardId)}`).join("&");

export const fetchBoardPresence = async (boardIds: string[]) => {
  if (boardIds.length === 0) {
    return null;
  }

  const query = buildBoardPresenceQuery(boardIds);
  const cacheBuster = `_ts=${Date.now()}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, 4000);

  try {
    const response = await fetch(buildBackendUrl(`/api/board-presence?${query}&${cacheBuster}`), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      presence?: Record<string, BoardPresence>;
    };

    return payload.presence ?? null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
};
