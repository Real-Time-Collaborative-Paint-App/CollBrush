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

## Architecture

- `server.ts` hosts Next.js and Socket.IO in one Node server.
- `app/page.tsx` handles board creation/join.
- `app/board/[boardId]/page.tsx` mounts a board session.
- `components/CollaborativeBoard.tsx` handles canvas rendering + realtime syncing.
- `lib/protocol.ts` contains shared event payload types.
