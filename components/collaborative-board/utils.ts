import type {
  BoardObject,
  DrawSegment,
  FillAction,
  Point,
  ReplaceCanvasAction,
  TextStyle,
} from "@/lib/protocol";
import type { SelectionRect, ShapeType } from "./types";

type WrappedTextLine = {
  text: string;
  y: number;
  width: number;
};

export const BOTTLE_NECK_ANGLE = -90;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const getRandomBit = () => {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] & 1;
  }

  return Math.random() < 0.5 ? 0 : 1;
};

export const getRandomIntInclusive = (min: number, max: number) => {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  if (high <= low) {
    return low;
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return low + (values[0] % (high - low + 1));
  }

  return low + Math.floor(Math.random() * (high - low + 1));
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: "Arial",
  fontSize: 24,
  color: "#111827",
  bold: false,
  italic: false,
  strikethrough: false,
  spoiler: false,
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const looksLikeHtml = (value: string) => /<\/?[a-z][\s\S]*>/i.test(value);

export const toMarkupContent = (value: string) => {
  if (!value) {
    return "";
  }

  if (looksLikeHtml(value)) {
    return value;
  }

  return escapeHtml(value).replaceAll("\n", "<br>");
};

export const normalizeBoardObject = (object: BoardObject): BoardObject => {
  if (object.type === "text") {
    return {
      ...object,
      width: object.width || 260,
      height: object.height || 120,
      rotation: object.rotation ?? 0,
      flipX: (object as { flipX?: boolean }).flipX ?? false,
      flipY: (object as { flipY?: boolean }).flipY ?? false,
      style: {
        ...DEFAULT_TEXT_STYLE,
        ...object.style,
      },
    };
  }

  return {
    ...object,
    width: object.width || 220,
    height: object.height || 160,
    rotation: object.rotation ?? 0,
    flipX: (object as { flipX?: boolean }).flipX ?? false,
    flipY: (object as { flipY?: boolean }).flipY ?? false,
    style: {
      ...DEFAULT_TEXT_STYLE,
      ...(object.style ?? {}),
      fontSize: object.style?.fontSize ?? 18,
    },
  };
};

const hexToRgba = (hexColor: string): [number, number, number, number] => {
  const hex = hexColor.replace("#", "").trim();
  if (hex.length !== 6) {
    return [17, 24, 39, 255];
  }

  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    255,
  ];
};

const toHex = (value: number) => value.toString(16).padStart(2, "0");

export const rgbaToHex = (red: number, green: number, blue: number) =>
  `#${toHex(red)}${toHex(green)}${toHex(blue)}`;

const colorsEqual = (
  data: Uint8ClampedArray,
  index: number,
  color: [number, number, number, number],
) =>
  data[index] === color[0] &&
  data[index + 1] === color[1] &&
  data[index + 2] === color[2] &&
  data[index + 3] === color[3];

export const normalizeRect = (from: Point, to: Point): SelectionRect => {
  const x1 = Math.floor(Math.min(from.x, to.x));
  const y1 = Math.floor(Math.min(from.y, to.y));
  const x2 = Math.floor(Math.max(from.x, to.x));
  const y2 = Math.floor(Math.max(from.y, to.y));

  return {
    x: x1,
    y: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
  };
};

export const pointInRect = (point: Point, rect: SelectionRect) =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

export const extractPlainText = (value: string) => {
  const markup = toMarkupContent(value);
  if (!markup) {
    return "";
  }

  if (typeof document === "undefined") {
    return markup.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "");
  }

  const node = document.createElement("div");
  node.innerHTML = markup;
  return node.innerText || node.textContent || "";
};

export const drawWrappedText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  lineHeight: number,
  strikethrough: boolean,
) => {
  if (maxWidth <= 1 || maxHeight <= 1) {
    return;
  }

  const lines: WrappedTextLine[] = [];
  const paragraphs = text.replaceAll("\r\n", "\n").split("\n");
  let currentY = y;

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      if (currentY + lineHeight > y + maxHeight) {
        break;
      }

      lines.push({ text: "", y: currentY, width: 0 });
      currentY += lineHeight;
      continue;
    }

    let line = words[0];
    for (let index = 1; index < words.length; index += 1) {
      const next = `${line} ${words[index]}`;
      if (ctx.measureText(next).width <= maxWidth) {
        line = next;
      } else {
        if (currentY + lineHeight > y + maxHeight) {
          break;
        }

        lines.push({ text: line, y: currentY, width: ctx.measureText(line).width });
        currentY += lineHeight;
        line = words[index];
      }
    }

    if (currentY + lineHeight > y + maxHeight) {
      break;
    }

    lines.push({ text: line, y: currentY, width: ctx.measureText(line).width });
    currentY += lineHeight;
  }

  for (const line of lines) {
    if (line.text) {
      ctx.fillText(line.text, x, line.y);
    }

    if (strikethrough && line.text) {
      const strikeY = line.y + lineHeight * 0.56;
      ctx.beginPath();
      ctx.moveTo(x, strikeY);
      ctx.lineTo(x + line.width, strikeY);
      ctx.lineWidth = Math.max(1, lineHeight * 0.07);
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.stroke();
    }
  }
};

export const drawSegmentOnContext = (ctx: CanvasRenderingContext2D, segment: DrawSegment) => {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = segment.color;
  ctx.lineWidth = segment.size;
  ctx.globalCompositeOperation = segment.mode === "erase" ? "destination-out" : "source-over";

  ctx.beginPath();
  ctx.moveTo(segment.from.x, segment.from.y);
  ctx.lineTo(segment.to.x, segment.to.y);
  ctx.stroke();
  ctx.restore();
};

export const applyFillToContext = (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  fill: FillAction,
) => {
  const startX = Math.floor(fill.point.x);
  const startY = Math.floor(fill.point.y);
  if (startX < 0 || startY < 0 || startX >= canvas.width || startY >= canvas.height) {
    return false;
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const targetIndex = (startY * canvas.width + startX) * 4;
  const target: [number, number, number, number] = [
    data[targetIndex],
    data[targetIndex + 1],
    data[targetIndex + 2],
    data[targetIndex + 3],
  ];
  const replacement = hexToRgba(fill.color);

  if (
    target[0] === replacement[0] &&
    target[1] === replacement[1] &&
    target[2] === replacement[2] &&
    target[3] === replacement[3]
  ) {
    return false;
  }

  const stack: number[] = [startX, startY];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;

    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
      continue;
    }

    const index = (y * canvas.width + x) * 4;
    if (!colorsEqual(data, index, target)) {
      continue;
    }

    data[index] = replacement[0];
    data[index + 1] = replacement[1];
    data[index + 2] = replacement[2];
    data[index + 3] = replacement[3];

    stack.push(x + 1, y);
    stack.push(x - 1, y);
    stack.push(x, y + 1);
    stack.push(x, y - 1);
  }

  ctx.putImageData(imageData, 0, 0);
  return true;
};

export const drawReplaceOnContext = async (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  replace: ReplaceCanvasAction,
) => {
  await new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve();
    };
    image.onerror = () => resolve();
    image.src = replace.dataUrl;
  });
};

export const drawShapeOutline = (
  ctx: CanvasRenderingContext2D,
  shape: ShapeType,
  from: Point,
  to: Point,
  strokeColor: string,
  strokeSize: number,
) => {
  const rect = normalizeRect(from, to);

  const drawPolygon = (points: Point[]) => {
    if (points.length < 2) {
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      ctx.lineTo(points[index].x, points[index].y);
    }
    ctx.closePath();
    ctx.stroke();
  };

  const createStarPoints = (arms: number, innerScale: number) => {
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const outerRadius = Math.max(2, Math.min(rect.width, rect.height) / 2);
    const innerRadius = outerRadius * innerScale;
    const points: Point[] = [];

    for (let index = 0; index < arms * 2; index += 1) {
      const angle = (-Math.PI / 2) + (index * Math.PI) / arms;
      const radius = index % 2 === 0 ? outerRadius : innerRadius;
      points.push({
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      });
    }

    return points;
  };

  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = clamp(strokeSize, 1, 40);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (shape === "rectangle") {
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    return;
  }

  if (shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      Math.max(1, rect.width / 2),
      Math.max(1, rect.height / 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (shape === "star") {
    drawPolygon(createStarPoints(5, 0.45));
    ctx.restore();
    return;
  }

  if (shape === "northern-star") {
    drawPolygon([
      { x: rect.x + rect.width * (12 / 24), y: rect.y + rect.height * (2 / 24) },
      { x: rect.x + rect.width * (14.5 / 24), y: rect.y + rect.height * (8.8 / 24) },
      { x: rect.x + rect.width * (22 / 24), y: rect.y + rect.height * (12 / 24) },
      { x: rect.x + rect.width * (14.5 / 24), y: rect.y + rect.height * (15.2 / 24) },
      { x: rect.x + rect.width * (12 / 24), y: rect.y + rect.height * (22 / 24) },
      { x: rect.x + rect.width * (9.5 / 24), y: rect.y + rect.height * (15.2 / 24) },
      { x: rect.x + rect.width * (2 / 24), y: rect.y + rect.height * (12 / 24) },
      { x: rect.x + rect.width * (9.5 / 24), y: rect.y + rect.height * (8.8 / 24) },
    ]);
    ctx.restore();
    return;
  }

  if (shape === "star-of-david") {
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const radius = Math.max(2, Math.min(rect.width, rect.height) / 2);
    const triangle = (offset: number) => {
      const points: Point[] = [];
      for (let index = 0; index < 3; index += 1) {
        const angle = offset + index * ((Math.PI * 2) / 3);
        points.push({
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
        });
      }
      return points;
    };

    drawPolygon(triangle(-Math.PI / 2));
    drawPolygon(triangle(Math.PI / 2));
    ctx.restore();
    return;
  }

  if (shape === "arrow") {
    drawPolygon([
      { x: rect.x, y: rect.y + rect.height * 0.35 },
      { x: rect.x + rect.width * 0.62, y: rect.y + rect.height * 0.35 },
      { x: rect.x + rect.width * 0.62, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
      { x: rect.x + rect.width * 0.62, y: rect.y + rect.height },
      { x: rect.x + rect.width * 0.62, y: rect.y + rect.height * 0.65 },
      { x: rect.x, y: rect.y + rect.height * 0.65 },
    ]);
    ctx.restore();
    return;
  }

  if (shape === "double-arrow") {
    drawPolygon([
      { x: rect.x, y: rect.y + rect.height / 2 },
      { x: rect.x + rect.width * 0.2, y: rect.y },
      { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.3 },
      { x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.3 },
      { x: rect.x + rect.width * 0.8, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
      { x: rect.x + rect.width * 0.8, y: rect.y + rect.height },
      { x: rect.x + rect.width * 0.8, y: rect.y + rect.height * 0.7 },
      { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.7 },
      { x: rect.x + rect.width * 0.2, y: rect.y + rect.height },
    ]);
    ctx.restore();
    return;
  }

  if (shape === "heart") {
    const samples = 96;
    const rawPoints: Point[] = [];
    for (let index = 0; index <= samples; index += 1) {
      const t = (index / samples) * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = -(
        13 * Math.cos(t) -
        5 * Math.cos(2 * t) -
        2 * Math.cos(3 * t) -
        Math.cos(4 * t)
      );
      rawPoints.push({ x, y });
    }

    const minX = Math.min(...rawPoints.map((point) => point.x));
    const maxX = Math.max(...rawPoints.map((point) => point.x));
    const minY = Math.min(...rawPoints.map((point) => point.y));
    const maxY = Math.max(...rawPoints.map((point) => point.y));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

    const mappedPoints = rawPoints.map((point) => ({
      x: rect.x + ((point.x - minX) / width) * rect.width,
      y: rect.y + ((point.y - minY) / height) * rect.height,
    }));

    drawPolygon(mappedPoints);
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
};
