"use client";

import Link from "next/link";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html>
      <body className="min-h-screen bg-zinc-100 px-4 py-10 text-zinc-900">
        <main className="mx-auto w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-zinc-600">
            An unexpected error occurred. You can retry or return to the main menu.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-800"
            >
              Try again
            </button>
            <Link
              href="/"
              className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-300"
            >
              Main menu
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
