# CollBrush

CollBrush is a real-time collaborative paint app built with Next.js + TypeScript.

## Features

- Shared board drawing in real-time with Socket.IO.
- Up to 10 concurrent users per board session.
- Multi-session support through unique board IDs and sharable board links.
- Smooth pointer drawing with pen/eraser tools, brush size control, and board clear.
- Responsive UI optimized for desktop and tablet browser drawing.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Scripts

- `npm run dev` - runs Next.js with custom Socket.IO server (`server.ts`).
- `npm run build` - production build.
- `npm run start` - starts production server using built app.
- `npm run lint` - lint project.
- `npm run typecheck` - strict TypeScript validation with no emit.
- `npm run test` - run unit tests.
- `npm run check` - full quality gate (`lint + typecheck + test + build`).

## Production readiness

- Run `npm run check` before deploys.
- Use `NODE_ENV=production npm run start` for runtime parity.
- Server persistence uses primary + temp + backup files under `.data/` for safer recovery.
- App includes `not-found` and global `error` boundaries for safer user-facing failure handling.

## Vercel deployment

This repo uses a custom realtime server (`server.ts`) for Socket.IO + persistence. Vercel should host the Next.js frontend, while realtime backend runs separately (e.g. Render/Railway/Fly/VM).

1. Deploy frontend to Vercel from this repo.
2. Deploy backend service that runs `server.ts` (`npm run start`).
3. In Vercel project settings, set environment variable:
	- `NEXT_PUBLIC_BACKEND_URL=https://your-backend-domain`
4. Redeploy frontend.

Notes:
- Frontend calls `/api/board-presence` and Socket.IO via `NEXT_PUBLIC_BACKEND_URL` when set.
- Without `NEXT_PUBLIC_BACKEND_URL`, frontend defaults to same-origin backend (local all-in-one mode).

Troubleshooting:
- If board shows `Cannot connect to realtime server`, set `NEXT_PUBLIC_BACKEND_URL` in Vercel to your deployed backend domain and redeploy.
- Use only backend origin (example: `https://your-backend-domain`) and do not append `/socket.io`.
- Backend must expose both `/socket.io` and `/api/board-presence` and allow cross-origin requests.

## Architecture

- `server.ts` hosts Next.js and Socket.IO in one Node server.
- `app/page.tsx` handles board creation/join.
- `app/board/[boardId]/page.tsx` mounts a board session.
- `components/CollaborativeBoard.tsx` handles canvas rendering + realtime syncing.
- `lib/protocol.ts` contains shared event payload types.

## Session logs

- Session change log is stored in `SESSION_HISTORY.txt` at the project root.

## Well-known Issues

- Bottle tool lacks synchronization
- Bottle in Bottle tool doesnt point to the winner
- Coin flip tool lacks visual appeal
