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

export interface FillAction {
  point: Point;
  color: string;
}

export interface ReplaceCanvasAction {
  dataUrl: string;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  spoiler: boolean;
}

export interface TextObject {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  content: string;
  style: TextStyle;
}

export interface StickyObject {
  id: string;
  type: "sticky";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  content: string;
  style: TextStyle;
}

export type BoardObject = TextObject | StickyObject;

export type BoardAction =
  | { type: "segment"; segment: DrawSegment }
  | { type: "fill"; fill: FillAction }
  | { type: "replace"; replace: ReplaceCanvasAction };

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
  cursorColor: string;
  animalEmoji: string;
}

export type JoinBoardErrorCode = "BOARD_FULL" | "INVALID_BOARD" | "INVALID_USER";

export interface JoinBoardSuccess {
  ok: true;
  actions: BoardAction[];
  objects: BoardObject[];
  usersCount: number;
  users: BoardUser[];
}

export interface JoinBoardFailure {
  ok: false;
  reason: string;
  code: JoinBoardErrorCode;
}

export type JoinBoardResponse = JoinBoardSuccess | JoinBoardFailure;
