import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-10 text-zinc-900">
      <main className="mx-auto w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-zinc-600">
          The page you requested does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-800"
        >
          Go to main menu
        </Link>
      </main>
    </div>
  );
}
