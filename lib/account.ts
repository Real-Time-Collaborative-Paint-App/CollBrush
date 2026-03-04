export type CollBrushAccount = {
  userId: string;
  nickname: string;
};

const ACCOUNT_STORAGE_KEY = "collbrush_account";

const clampText = (value: string, max: number) => value.trim().slice(0, max);

const generateUserId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const readStoredAccount = (): CollBrushAccount | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CollBrushAccount>;
    const userId = clampText(parsed.userId ?? "", 80);
    const nickname = clampText(parsed.nickname ?? "", 40);

    if (!userId || !nickname) {
      return null;
    }

    return { userId, nickname };
  } catch {
    return null;
  }
};

export const saveAccount = (input: Partial<CollBrushAccount>): CollBrushAccount => {
  const userId = clampText(input.userId ?? "", 80) || generateUserId();
  const nickname = clampText(input.nickname ?? "", 40);

  const account: CollBrushAccount = {
    userId,
    nickname,
  };

  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
  }

  return account;
};
