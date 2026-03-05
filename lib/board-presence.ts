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
    const response = await fetch(`/api/board-presence?${query}&${cacheBuster}`, {
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
