import type { BoardObject, DrawMode, Point } from "@/lib/protocol";

export type CollaborativeBoardProps = {
  boardId: string;
  userId: string;
  nickname: string;
};

export type ToolMode = DrawMode | "bucket" | "select" | "drag" | "picker" | "text" | "sticky" | "zoom" | "shape";

export type ShapeType =
  | "rectangle"
  | "ellipse"
  | "line"
  | "star"
  | "star-of-david"
  | "northern-star"
  | "arrow"
  | "double-arrow"
  | "heart";

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SnapshotHistoryEntry = {
  before: string;
  after: string;
};

export type ResizeSession = {
  startPoint: Point;
  startWidth: number;
  startHeight: number;
};

export type RotateSession = {
  center: Point;
  startPointerAngle: number;
  startRotation: number;
};

export type CreateObjectSession = {
  pointerId: number;
  mode: "text" | "sticky";
  startPoint: Point;
  currentPoint: Point;
};

export type ShapeSession = {
  pointerId: number;
  startPoint: Point;
  currentPoint: Point;
  baseImage: ImageData;
  beforeSnapshot: string;
};

export type SelectionTransformMode = "resize" | "rotate";

export type SelectionTransformSession = {
  mode: SelectionTransformMode;
  startRect: SelectionRect;
  startPoint: Point;
  center: Point;
  startDistance: number;
  startAngle: number;
  baseImage: ImageData;
  selectionCanvas: HTMLCanvasElement;
  beforeSnapshot: string;
  affectedObjects: BoardObject[];
};

export type ConfettiPiece = {
  id: string;
  dx: number;
  dy: number;
  rotation: number;
  duration: number;
  delay: number;
  colorClass: string;
};

export type ConfettiBurst = {
  id: string;
  x: number;
  y: number;
  pieces: ConfettiPiece[];
};

export type SharknadoShark = {
  id: string;
  lane: number;
  sway: number;
  startScale: number;
  peakScale: number;
  endScale: number;
  drift: number;
  delay: number;
  duration: number;
};

export type SharknadoBreakaway = {
  id: string;
  dx: number;
  dy: number;
  rotation: number;
  scale: number;
  delay: number;
  duration: number;
};

export type SharknadoBurst = {
  id: string;
  x: number;
  y: number;
  sharks: SharknadoShark[];
  breakaways: SharknadoBreakaway[];
  wobbleX: number;
  wobbleY: number;
  wobbleDuration: number;
};

export type CoinflipBurst = {
  id: string;
  x: number;
  y: number;
  result: "Heads" | "Tails";
};

export type BottleParticipant = {
  id: string;
  nickname: string;
  emoji: string;
  color: string;
  angle: number;
};

export type BottleBurst = {
  id: string;
  x: number;
  y: number;
  participants: BottleParticipant[];
  selectedId: string;
  bottleRotation: number;
  duration: number;
};
