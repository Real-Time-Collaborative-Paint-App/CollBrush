export type DrawMode = "draw" | "erase";

export interface Point {
  x: number;
  y: number;
}

export interface DrawSegment {
  from: Point;
  to: Point;
  color: string;
  size: number;
  mode: DrawMode;
}

export interface BoardUser {
  socketId: string;
  userId: string;
  nickname: string;
  cursorColor: string;
  animalEmoji: string;
}

export interface JoinBoardRequest {
  boardId: string;
  userId: string;
  nickname: string;
}

export interface CursorMovePayload {
  x: number;
  y: number;
}

export interface CursorState extends CursorMovePayload {
  socketId: string;
  userId: string;
  nickname: string;
}

export type JoinBoardErrorCode = "BOARD_FULL" | "INVALID_BOARD" | "INVALID_USER";

export interface JoinBoardSuccess {
  ok: true;
  segments: DrawSegment[];
  usersCount: number;
  users: BoardUser[];
}

export interface JoinBoardFailure {
  ok: false;
  reason: string;
  code: JoinBoardErrorCode;
}

export type JoinBoardResponse = JoinBoardSuccess | JoinBoardFailure;
