"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { readStoredAccount } from "@/lib/account";
import { type BoardPresence, fetchBoardPresence } from "@/lib/board-presence";
import {
  type StoredBoard,
  readStoredBoards,
  removeStoredBoard,
  renameStoredBoard,
} from "@/lib/boards";

export default function MyBoardsPage() {
  const router = useRouter();
  const [session] = useState(() => {
    const account = readStoredAccount();
    if (!account) {
      return {
        userId: "",
        nickname: "",
        initialBoards: [] as StoredBoard[],
      };
    }

    return {
      userId: account.userId,
      nickname: account.nickname,
      initialBoards: readStoredBoards(account.userId),
    };
  });
  const [boards, setBoards] = useState<StoredBoard[]>(session.initialBoards);
  const [presenceByBoard, setPresenceByBoard] = useState<Record<string, BoardPresence>>({});
  const userId = session.userId;
  const nickname = session.nickname;

  const hasAccount = useMemo(() => Boolean(userId && nickname), [nickname, userId]);

  const openBoard = (boardId: string) => {
    if (!hasAccount) {
      router.push("/?error=login-required");
      return;
    }

    const params = new URLSearchParams({
      uid: userId,
      name: nickname,
    });
    router.push(`/board/${encodeURIComponent(boardId)}?${params.toString()}`);
  };

  const onRenameBoard = (boardId: string, nextName: string) => {
    if (!userId) {
      return;
    }

    setBoards(renameStoredBoard(userId, boardId, nextName));
  };

  const onDeleteBoard = (boardId: string) => {
    if (!userId) {
      return;
    }

    setBoards(removeStoredBoard(userId, boardId));
  };

  useEffect(() => {
    if (!hasAccount || boards.length === 0) {
      return;
    }

    let active = true;

    const fetchPresence = async () => {
      const presence = await fetchBoardPresence(boards.map((board) => board.id));
      if (!active || !presence) {
        return;
      }

      setPresenceByBoard(presence);
    };

    void fetchPresence();
    const intervalId = window.setInterval(() => {
      void fetchPresence();
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [boards, hasAccount]);

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <main className="mx-auto w-full max-w-5xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">My boards</h1>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            ⬅ Back to main menu
          </button>
        </div>

        {!hasAccount ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
            Sign in on the main page to see your saved boards.
          </div>
        ) : boards.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-6 text-sm text-zinc-600">
            No boards yet. Create one from the main page.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <article key={board.id} className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
                <button
                  type="button"
                  onClick={() => openBoard(board.id)}
                  className="block w-full bg-zinc-100"
                >
                  {board.previewDataUrl ? (
                    <Image
                      src={board.previewDataUrl}
                      alt={`${board.name} preview`}
                      width={720}
                      height={400}
                      className="h-40 w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-40 w-full place-items-center text-sm text-zinc-500">No preview yet</div>
                  )}
                </button>

                <div className="space-y-2 p-3">
                  <input
                    defaultValue={board.name}
                    maxLength={80}
                    onBlur={(event) => onRenameBoard(board.id, event.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none transition focus:border-zinc-500"
                    aria-label="Board name"
                  />
                  <p className="text-xs text-zinc-500">ID: {board.id}</p>
                  <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5">
                    <p className="text-xs font-medium text-zinc-700">
                      Active right now: {presenceByBoard[board.id]?.usersCount ?? 0}
                    </p>
                    {(presenceByBoard[board.id]?.usersCount ?? 0) > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(presenceByBoard[board.id]?.users ?? []).map((user) => (
                          <span
                            key={`${board.id}-${user.userId}-${user.nickname}`}
                            className="rounded-full border bg-white px-2 py-0.5 text-[11px] font-medium"
                            style={{
                              color: user.cursorColor,
                              borderColor: user.cursorColor,
                            }}
                          >
                            {user.animalEmoji} {user.nickname}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-[11px] text-zinc-500">No users online right now</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openBoard(board.id)}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteBoard(board.id)}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
