import type { ShapeType } from "./types";

export const SHAPE_OPTIONS: Array<{ value: ShapeType; label: string }> = [
  { value: "rectangle", label: "Rectangle" },
  { value: "ellipse", label: "Ellipse" },
  { value: "heart", label: "Heart" },
  { value: "line", label: "Line" },
  { value: "star", label: "Star" },
  { value: "star-of-david", label: "Star of David" },
  { value: "northern-star", label: "Northern Star" },
  { value: "arrow", label: "Arrow" },
  { value: "double-arrow", label: "Double Arrow" },
];

export const getShapeLabel = (shape: ShapeType) =>
  SHAPE_OPTIONS.find((option) => option.value === shape)?.label ?? "Shape";

export const renderShapeOutlineIcon = (shape: ShapeType) => {
  const baseProps = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    className: "shrink-0",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (shape === "rectangle") {
    return <svg {...baseProps}><rect x="4" y="5" width="16" height="14" /></svg>;
  }

  if (shape === "ellipse") {
    return <svg {...baseProps}><ellipse cx="12" cy="12" rx="8" ry="6.5" /></svg>;
  }

  if (shape === "line") {
    return <svg {...baseProps}><line x1="4" y1="18" x2="20" y2="6" /></svg>;
  }

  if (shape === "star") {
    return <svg {...baseProps}><polygon points="12,2.5 14.8,8.5 21.5,9.2 16.4,13.6 18,20.8 12,16.8 6,20.8 7.6,13.6 2.5,9.2 9.2,8.5" /></svg>;
  }

  if (shape === "star-of-david") {
    return <svg {...baseProps}><polygon points="12,3 19,15 5,15" /><polygon points="12,21 19,9 5,9" /></svg>;
  }

  if (shape === "northern-star") {
    return <svg {...baseProps}><polygon points="12,2 14.5,8.8 22,12 14.5,15.2 12,22 9.5,15.2 2,12 9.5,8.8" /></svg>;
  }

  if (shape === "arrow") {
    return <svg {...baseProps}><polygon points="3,9 14,9 14,5 21,12 14,19 14,15 3,15" /></svg>;
  }

  if (shape === "heart") {
    return <svg {...baseProps}><path d="M12 21 C4 15,3 10,6.5 7.5 C8.7 5.9,11 6.7,12 8.6 C13 6.7,15.3 5.9,17.5 7.5 C21 10,20 15,12 21 Z" /></svg>;
  }

  return <svg {...baseProps}><polygon points="2,12 7,7 7,10 17,10 17,7 22,12 17,17 17,14 7,14 7,17" /></svg>;
};
