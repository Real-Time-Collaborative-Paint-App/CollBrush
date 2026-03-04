"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { readStoredAccount, saveAccount } from "@/lib/account";

const createBoardId = () => {
  const randomChunk = Math.random().toString(36).slice(2, 6);
  return `board-${Date.now().toString(36)}-${randomChunk}`;
};

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [boardId, setBoardId] = useState("");
  const [nickname, setNickname] = useState("");
  const fullBoardError = searchParams.get("error") === "board-full";
  const loginRequiredError = searchParams.get("error") === "login-required";

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedAccount = readStoredAccount();
    if (storedAccount) {
      setNickname(storedAccount.nickname);
    }
  }, []);

  const ensureNickname = () => {
    const currentNickname = nickname.trim().slice(0, 40);
    if (currentNickname) {
      return currentNickname;
    }

    if (typeof window === "undefined") {
      return "";
    }

    const promptedNickname = window.prompt("Enter your nickname", "")?.trim().slice(0, 40) ?? "";
    if (!promptedNickname) {
      return "";
    }

    setNickname(promptedNickname);
    saveAccount({ nickname: promptedNickname });
    return promptedNickname;
  };

  const goToBoard = (nextBoardId: string) => {
    const sanitized = nextBoardId.trim().slice(0, 80);
    const safeNickname = ensureNickname();

    if (!sanitized || !safeNickname) {
      return;
    }

    const account = saveAccount({ nickname: safeNickname });

    const params = new URLSearchParams({
      uid: account.userId,
      name: account.nickname,
    });

    router.push(`/board/${encodeURIComponent(sanitized)}?${params.toString()}`);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    goToBoard(boardId);
  };

  return (
    <div className="grid min-h-screen place-items-center bg-zinc-100 px-4 py-8">
      <main className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">CollBrush</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Real-time collaborative paint board. Share a board link and draw together (up to 10 users per board).
        </p>
        {fullBoardError ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            This Board is full
          </p>
        ) : null}
        {loginRequiredError ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700">
            Enter your nickname to join a board
          </p>
        ) : null}

        <div className="mt-5 space-y-2">
          <label className="block text-sm font-medium text-zinc-700" htmlFor="nickname">
            Your nickname
          </label>
          <input
            id="nickname"
            value={nickname}
            maxLength={40}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Enter nickname"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition focus:border-zinc-500"
          />
        </div>

        <form className="mt-6 space-y-3" onSubmit={onSubmit}>
          <label className="block text-sm font-medium text-zinc-700" htmlFor="boardId">
            Join existing board
          </label>
          <input
            id="boardId"
            value={boardId}
            onChange={(event) => setBoardId(event.target.value)}
            placeholder="Enter board ID"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none transition focus:border-zinc-500"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800"
          >
            Join board
          </button>
        </form>

        <div className="my-4 h-px bg-zinc-200" />

        <button
          type="button"
          onClick={() => goToBoard(createBoardId())}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          Create new board
        </button>
      </main>
    </div>
  );
}
