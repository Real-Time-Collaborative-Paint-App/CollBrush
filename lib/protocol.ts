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

export interface JoinBoardSuccess {
  ok: true;
  segments: DrawSegment[];
  usersCount: number;
}

export interface JoinBoardFailure {
  ok: false;
  reason: string;
}

export type JoinBoardResponse = JoinBoardSuccess | JoinBoardFailure;
