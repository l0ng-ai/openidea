/** Excalidraw scene model, parser, serializer, hit-testing, and SVG renderer. */

export type ExcalidrawElementType =
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "image"
  | "frame";

export type ExcalidrawTool =
  | "selection"
  | "hand"
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text";

export type ExcalidrawFillStyle = "hachure" | "cross-hatch" | "solid";
export type ExcalidrawStrokeStyle = "solid" | "dashed" | "dotted";
export type ExcalidrawArrowhead = "arrow" | "bar" | "dot" | "triangle" | null;
export type ExcalidrawTextAlign = "left" | "center" | "right";
export type ExcalidrawVerticalAlign = "top" | "middle" | "bottom";
export type ExcalidrawPoint = readonly [number, number];

export interface ExcalidrawBoundElementRef {
  id: string;
  type: "text" | "arrow";
}

export interface ExcalidrawElement {
  id: string;
  type: ExcalidrawElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: ExcalidrawFillStyle;
  strokeWidth?: number;
  strokeStyle?: ExcalidrawStrokeStyle;
  roughness?: number;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  roundness?: { type: number; value?: number } | null;
  seed?: number;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  boundElements?: ExcalidrawBoundElementRef[] | null;
  updated?: number;
  link?: string | null;
  locked?: boolean;
  /** Text element or inline shape label fields. */
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: ExcalidrawTextAlign;
  verticalAlign?: ExcalidrawVerticalAlign;
  containerId?: string | null;
  originalText?: string;
  lineHeight?: number;
  /** Linear / freedraw element fields. */
  points?: ExcalidrawPoint[];
  startArrowhead?: ExcalidrawArrowhead;
  endArrowhead?: ExcalidrawArrowhead;
  startBinding?: { elementId: string; focus?: number; gap?: number } | null;
  endBinding?: { elementId: string; focus?: number; gap?: number } | null;
  /** Image element fields. */
  fileId?: string | null;
  /** Frame element fields. */
  name?: string | null;
  /** Optional shorthand label in hand-authored or AI-generated scenes. */
  label?: { text?: string; strokeColor?: string; fontSize?: number };
}

export interface ExcalidrawAppState {
  gridSize?: number | null;
  viewBackgroundColor?: string;
  [key: string]: unknown;
}

export interface ExcalidrawBinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
}

export interface ExcalidrawDocument {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: ExcalidrawAppState;
  files: Record<string, ExcalidrawBinaryFile>;
}

export interface ExcalidrawBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export interface ExcalidrawStyleOptions {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: ExcalidrawFillStyle;
  strokeWidth: number;
  strokeStyle: ExcalidrawStrokeStyle;
  opacity: number;
  fontSize: number;
}

export const EXCALIDRAW_STROKE_COLORS = [
  "#1e1e1e",
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#6741d9",
  "#0c8599",
] as const;

export const EXCALIDRAW_BG_COLORS = [
  "transparent",
  "#ffc9c9",
  "#b2f2bb",
  "#a5d8ff",
  "#ffec99",
  "#d0bfff",
  "#e9ecef",
] as const;

const VALID_TYPES = new Set<ExcalidrawElementType>([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "image",
  "frame",
]);

let nextIdCounter = 1;

export function generateElementId(prefix = "el"): string {
  nextIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextIdCounter.toString(36)}`;
}

export function createEmptyScene(): ExcalidrawDocument {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: {
      gridSize: null,
      viewBackgroundColor: "#ffffff",
    },
    files: {},
  };
}

function toFiniteNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizePoints(raw: unknown, width: number, height: number): ExcalidrawPoint[] {
  if (Array.isArray(raw) && raw.length > 0) {
    const pts: ExcalidrawPoint[] = [];
    for (const item of raw) {
      if (Array.isArray(item) && item.length >= 2) {
        pts.push([toFiniteNumber(item[0]), toFiniteNumber(item[1])]);
      }
    }
    if (pts.length > 0) return pts;
  }
  return [
    [0, 0],
    [width, height],
  ];
}

function normalizeElement(raw: unknown, index: number): ExcalidrawElement | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rawType = typeof obj.type === "string" ? (obj.type as ExcalidrawElementType) : null;
  if (!rawType || !VALID_TYPES.has(rawType)) return null;

  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id : `element-${index + 1}`;
  const x = toFiniteNumber(obj.x, 0);
  const y = toFiniteNumber(obj.y, 0);
  const textValue = typeof obj.text === "string" ? obj.text : undefined;
  const fontSize = toFiniteNumber(obj.fontSize, 20);
  const defaultWidth = rawType === "text" ? Math.max(40, (textValue?.length ?? 4) * fontSize * 0.58) : 120;
  const defaultHeight = rawType === "text" ? Math.max(24, (textValue?.split("\n").length ?? 1) * fontSize * 1.25) : 60;
  const width = toFiniteNumber(obj.width, defaultWidth);
  const height = toFiniteNumber(obj.height, defaultHeight);

  const el: ExcalidrawElement = {
    ...obj,
    id,
    type: rawType,
    x,
    y,
    width,
    height,
    angle: toFiniteNumber(obj.angle, 0),
    strokeColor: typeof obj.strokeColor === "string" ? obj.strokeColor : "#1e1e1e",
    backgroundColor: typeof obj.backgroundColor === "string" ? obj.backgroundColor : "transparent",
    fillStyle:
      obj.fillStyle === "hachure" || obj.fillStyle === "cross-hatch" || obj.fillStyle === "solid"
        ? obj.fillStyle
        : "solid",
    strokeWidth: toFiniteNumber(obj.strokeWidth, 2),
    strokeStyle:
      obj.strokeStyle === "dashed" || obj.strokeStyle === "dotted" || obj.strokeStyle === "solid"
        ? obj.strokeStyle
        : "solid",
    roughness: toFiniteNumber(obj.roughness, 1),
    opacity: Math.max(0, Math.min(100, toFiniteNumber(obj.opacity, 100))),
    isDeleted: Boolean(obj.isDeleted),
    fontSize,
    fontFamily: toFiniteNumber(obj.fontFamily, 1),
    textAlign:
      obj.textAlign === "left" || obj.textAlign === "center" || obj.textAlign === "right" ? obj.textAlign : "left",
    verticalAlign:
      obj.verticalAlign === "top" || obj.verticalAlign === "middle" || obj.verticalAlign === "bottom"
        ? obj.verticalAlign
        : "top",
    containerId: typeof obj.containerId === "string" ? obj.containerId : null,
  };

  if (rawType === "arrow" || rawType === "line" || rawType === "freedraw") {
    el.points = normalizePoints(obj.points, width, height);
    el.startArrowhead = (obj.startArrowhead as ExcalidrawArrowhead) ?? null;
    el.endArrowhead =
      obj.endArrowhead !== undefined ? (obj.endArrowhead as ExcalidrawArrowhead) : rawType === "arrow" ? "arrow" : null;
  }

  return el;
}

export function parseExcalidrawScene(
  raw: string,
): { scene: ExcalidrawDocument; error: null } | { scene: null; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { scene: createEmptyScene(), error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      scene: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (Array.isArray(parsed)) {
    const elements = parsed
      .map((item, idx) => normalizeElement(item, idx))
      .filter((item): item is ExcalidrawElement => item !== null);
    return {
      scene: {
        ...createEmptyScene(),
        elements,
      },
      error: null,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      scene: null,
      error: "Excalidraw document must be a JSON object.",
    };
  }

  const doc = parsed as Record<string, unknown>;
  if (doc.type !== undefined && doc.type !== "excalidraw" && !Array.isArray(doc.elements)) {
    return {
      scene: null,
      error: `Expected type "excalidraw", got ${JSON.stringify(doc.type)}.`,
    };
  }

  const rawElements = Array.isArray(doc.elements) ? doc.elements : [];
  const elements = rawElements
    .map((item, idx) => normalizeElement(item, idx))
    .filter((item): item is ExcalidrawElement => item !== null);

  const rawAppState = doc.appState && typeof doc.appState === "object" ? (doc.appState as ExcalidrawAppState) : {};
  const appState: ExcalidrawAppState = {
    gridSize: rawAppState.gridSize ?? null,
    viewBackgroundColor:
      typeof rawAppState.viewBackgroundColor === "string" ? rawAppState.viewBackgroundColor : "#ffffff",
    ...rawAppState,
  };

  const files: Record<string, ExcalidrawBinaryFile> = {};
  if (doc.files && typeof doc.files === "object") {
    for (const [key, val] of Object.entries(doc.files as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const f = val as Record<string, unknown>;
        if (typeof f.dataURL === "string") {
          files[key] = {
            id: typeof f.id === "string" ? f.id : key,
            mimeType: typeof f.mimeType === "string" ? f.mimeType : "image/png",
            dataURL: f.dataURL,
            created: typeof f.created === "number" ? f.created : undefined,
          };
        }
      }
    }
  }

  return {
    scene: {
      type: "excalidraw",
      version: typeof doc.version === "number" ? doc.version : 2,
      source: typeof doc.source === "string" ? doc.source : "https://excalidraw.com",
      elements,
      appState,
      files,
    },
    error: null,
  };
}

export function serializeExcalidrawScene(scene: ExcalidrawDocument): string {
  const payload: ExcalidrawDocument = {
    type: "excalidraw",
    version: scene.version || 2,
    source: scene.source || "https://excalidraw.com",
    elements: scene.elements.filter((el) => !el.isDeleted),
    appState: {
      gridSize: scene.appState?.gridSize ?? null,
      viewBackgroundColor: scene.appState?.viewBackgroundColor ?? "#ffffff",
      ...scene.appState,
    },
    files: scene.files ?? {},
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function visibleElements(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.filter((el) => !el.isDeleted);
}

export function getElementBounds(el: ExcalidrawElement): ExcalidrawBounds {
  if ((el.type === "arrow" || el.type === "line" || el.type === "freedraw") && el.points && el.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of el.points) {
      const gx = el.x + px;
      const gy = el.y + py;
      if (gx < minX) minX = gx;
      if (gy < minY) minY = gy;
      if (gx > maxX) maxX = gx;
      if (gy > maxY) maxY = gy;
    }
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    return {
      minX,
      minY,
      maxX,
      maxY,
      width,
      height,
      cx: minX + width / 2,
      cy: minY + height / 2,
    };
  }

  const minX = Math.min(el.x, el.x + el.width);
  const minY = Math.min(el.y, el.y + el.height);
  const maxX = Math.max(el.x, el.x + el.width);
  const maxY = Math.max(el.y, el.y + el.height);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    cx: minX + width / 2,
    cy: minY + height / 2,
  };
}

export function getSceneBounds(elements: readonly ExcalidrawElement[]): ExcalidrawBounds {
  const active = visibleElements(elements);
  if (active.length === 0) {
    return { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400, cx: 300, cy: 200 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of active) {
    if (el.type === "text" && el.containerId) continue;
    const b = getElementBounds(el);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400, cx: 300, cy: 200 };
  }
  const width = Math.max(40, maxX - minX);
  const height = Math.max(40, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    cx: minX + width / 2,
    cy: minY + height / 2,
  };
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitTestElement(
  elements: readonly ExcalidrawElement[],
  x: number,
  y: number,
  tolerance = 8,
): ExcalidrawElement | null {
  const active = visibleElements(elements);
  for (let i = active.length - 1; i >= 0; i -= 1) {
    const el = active[i]!;
    if (el.type === "text" && el.containerId) continue;
    if ((el.type === "arrow" || el.type === "line" || el.type === "freedraw") && el.points && el.points.length >= 2) {
      for (let j = 0; j < el.points.length - 1; j += 1) {
        const [x1, y1] = el.points[j]!;
        const [x2, y2] = el.points[j + 1]!;
        if (distanceToSegment(x, y, el.x + x1, el.y + y1, el.x + x2, el.y + y2) <= tolerance) {
          return el;
        }
      }
      continue;
    }
    const b = getElementBounds(el);
    if (x >= b.minX - tolerance && x <= b.maxX + tolerance && y >= b.minY - tolerance && y <= b.maxY + tolerance) {
      return el;
    }
  }
  return null;
}

export function getElementLabel(el: ExcalidrawElement, elements: readonly ExcalidrawElement[]): string {
  if (el.type === "text") return el.text ?? "";
  if (el.type === "frame") return el.name ?? "";
  const boundText = elements.find((item) => !item.isDeleted && item.type === "text" && item.containerId === el.id);
  if (boundText?.text) return boundText.text;
  if (typeof el.label?.text === "string") return el.label.text;
  if (typeof el.text === "string") return el.text;
  return "";
}

export function setElementLabel(scene: ExcalidrawDocument, elementId: string, nextText: string): ExcalidrawDocument {
  const target = scene.elements.find((el) => el.id === elementId && !el.isDeleted);
  if (!target) return scene;

  if (target.type === "text") {
    const fontSize = target.fontSize ?? 20;
    const lines = nextText.split("\n");
    const maxCols = Math.max(1, ...lines.map((l) => l.length));
    const width = Math.max(40, Math.round(maxCols * fontSize * 0.58));
    const height = Math.max(24, Math.round(lines.length * fontSize * 1.25));
    return {
      ...scene,
      elements: scene.elements.map((el) =>
        el.id === elementId ? { ...el, text: nextText, originalText: nextText, width, height } : el,
      ),
    };
  }

  if (target.type === "frame") {
    return {
      ...scene,
      elements: scene.elements.map((el) => (el.id === elementId ? { ...el, name: nextText } : el)),
    };
  }

  const existingBound = scene.elements.find(
    (el) => !el.isDeleted && el.type === "text" && el.containerId === elementId,
  );
  const trimmed = nextText.trim();

  if (!trimmed) {
    return {
      ...scene,
      elements: scene.elements
        .filter((el) => !(el.type === "text" && el.containerId === elementId))
        .map((el) => {
          if (el.id !== elementId) return el;
          const next = { ...el };
          delete next.text;
          delete next.label;
          if (Array.isArray(next.boundElements)) {
            next.boundElements = next.boundElements.filter((b) => b.type !== "text");
          }
          return next;
        }),
    };
  }

  const fontSize = existingBound?.fontSize ?? 18;
  const lines = nextText.split("\n");
  const textWidth = Math.max(30, Math.min(Math.abs(target.width) - 16, Math.round(nextText.length * fontSize * 0.55)));
  const textHeight = Math.max(22, Math.round(lines.length * fontSize * 1.25));
  const b = getElementBounds(target);
  const textX = Math.round(b.cx - textWidth / 2);
  const textY = Math.round(b.cy - textHeight / 2);

  if (existingBound) {
    return {
      ...scene,
      elements: scene.elements.map((el) => {
        if (el.id === existingBound.id) {
          return {
            ...el,
            x: textX,
            y: textY,
            width: textWidth,
            height: textHeight,
            text: nextText,
            originalText: nextText,
          };
        }
        if (el.id === elementId) {
          const copy = { ...el };
          delete copy.label;
          delete copy.text;
          return copy;
        }
        return el;
      }),
    };
  }

  const textId = generateElementId("text");
  const boundTextElement: ExcalidrawElement = {
    id: textId,
    type: "text",
    x: textX,
    y: textY,
    width: textWidth,
    height: textHeight,
    strokeColor: target.strokeColor ?? "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: target.opacity ?? 100,
    fontSize,
    fontFamily: 1,
    text: nextText,
    originalText: nextText,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: elementId,
  };

  return {
    ...scene,
    elements: [
      ...scene.elements.map((el) => {
        if (el.id !== elementId) return el;
        const copy = { ...el };
        delete copy.label;
        delete copy.text;
        const existingRefs = Array.isArray(copy.boundElements) ? copy.boundElements : [];
        copy.boundElements = [...existingRefs.filter((r) => r.type !== "text"), { id: textId, type: "text" as const }];
        return copy;
      }),
      boundTextElement,
    ],
  };
}

export function createElement(
  tool: Exclude<ExcalidrawTool, "selection" | "hand">,
  x: number,
  y: number,
  width: number,
  height: number,
  style: Partial<ExcalidrawStyleOptions & ExcalidrawElement> = {},
): ExcalidrawElement {
  const id = style.id ?? generateElementId(tool);
  const strokeColor = style.strokeColor ?? "#1e1e1e";
  const backgroundColor = style.backgroundColor ?? "transparent";
  const fillStyle = style.fillStyle ?? "solid";
  const strokeWidth = style.strokeWidth ?? 2;
  const strokeStyle = style.strokeStyle ?? "solid";
  const opacity = style.opacity ?? 100;
  const fontSize = style.fontSize ?? 20;

  if (tool === "arrow" || tool === "line" || tool === "freedraw") {
    const dx = Math.abs(width) < 8 && Math.abs(height) < 8 ? 120 : width;
    const dy = Math.abs(width) < 8 && Math.abs(height) < 8 ? 0 : height;
    return {
      ...style,
      id,
      type: tool,
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(Math.abs(dx)),
      height: Math.round(Math.abs(dy)),
      strokeColor,
      backgroundColor: "transparent",
      fillStyle,
      strokeWidth,
      strokeStyle,
      roughness: 1,
      opacity,
      points: style.points ?? [
        [0, 0],
        [Math.round(dx), Math.round(dy)],
      ],
      startArrowhead: style.startArrowhead ?? null,
      endArrowhead: style.endArrowhead !== undefined ? style.endArrowhead : tool === "arrow" ? "arrow" : null,
    };
  }

  if (tool === "text") {
    const initialText = style.text ?? "Text";
    return {
      ...style,
      id,
      type: "text",
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(48, Math.round(initialText.length * fontSize * 0.6)),
      height: Math.max(24, Math.round(fontSize * 1.25)),
      strokeColor,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity,
      fontSize,
      fontFamily: 1,
      text: initialText,
      originalText: initialText,
      textAlign: style.textAlign ?? "left",
      verticalAlign: style.verticalAlign ?? "top",
      containerId: style.containerId ?? null,
    };
  }

  const normX = width < 0 ? x + width : x;
  const normY = height < 0 ? y + height : y;
  const normW = Math.max(32, Math.abs(width) < 8 ? 120 : Math.abs(width));
  const normH = Math.max(28, Math.abs(height) < 8 ? 64 : Math.abs(height));

  return {
    ...style,
    id,
    type: tool,
    x: Math.round(normX),
    y: Math.round(normY),
    width: Math.round(normW),
    height: Math.round(normH),
    strokeColor,
    backgroundColor,
    fillStyle,
    strokeWidth,
    strokeStyle,
    roughness: 1,
    opacity,
    roundness: tool === "rectangle" ? { type: 3 } : null,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function strokeDasharray(style: ExcalidrawStrokeStyle | undefined, strokeWidth: number): string | undefined {
  if (style === "dashed") return `${Math.max(6, strokeWidth * 4)} ${Math.max(4, strokeWidth * 2.5)}`;
  if (style === "dotted") return `${Math.max(2, strokeWidth)} ${Math.max(3, strokeWidth * 2)}`;
  return undefined;
}

function fontFamilyStack(fontFamily: number | undefined): string {
  if (fontFamily === 3) return "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)";
  if (fontFamily === 2) return "var(--font-ui, -apple-system, BlinkMacSystemFont, sans-serif)";
  return "'Virgil', 'Segoe Print', 'Bradley Hand', 'Chalkboard SE', cursive, sans-serif";
}

function adaptDarkColor(color: string | undefined, dark: boolean, isBackground = false): string {
  if (!color || color === "transparent") return "transparent";
  if (!dark) return color;
  const lower = color.trim().toLowerCase();
  if (isBackground) {
    if (lower === "#ffffff" || lower === "#fff") return "#1e1f22";
    return color;
  }
  if (lower === "#1e1e1e" || lower === "#000000" || lower === "#000") return "#e6e8ec";
  return color;
}

function renderArrowheadMarkup(
  kind: ExcalidrawArrowhead,
  tipX: number,
  tipY: number,
  fromX: number,
  fromY: number,
  strokeColor: string,
  strokeWidth: number,
): string {
  if (!kind) return "";
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const size = Math.max(8, strokeWidth * 4.5);

  if (kind === "dot") {
    return `<circle cx="${tipX.toFixed(1)}" cy="${tipY.toFixed(1)}" r="${(size * 0.45).toFixed(1)}" fill="${escapeXml(strokeColor)}" />`;
  }

  if (kind === "bar") {
    const dx = Math.sin(angle) * (size * 0.6);
    const dy = -Math.cos(angle) * (size * 0.6);
    return `<line x1="${(tipX - dx).toFixed(1)}" y1="${(tipY - dy).toFixed(1)}" x2="${(tipX + dx).toFixed(1)}" y2="${(tipY + dy).toFixed(1)}" stroke="${escapeXml(strokeColor)}" stroke-width="${strokeWidth}" stroke-linecap="round" />`;
  }

  const spread = Math.PI / 6;
  const x1 = tipX - size * Math.cos(angle - spread);
  const y1 = tipY - size * Math.sin(angle - spread);
  const x2 = tipX - size * Math.cos(angle + spread);
  const y2 = tipY - size * Math.sin(angle + spread);

  if (kind === "triangle") {
    return `<polygon points="${tipX.toFixed(1)},${tipY.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="${escapeXml(strokeColor)}" stroke="${escapeXml(strokeColor)}" stroke-width="${strokeWidth}" stroke-linejoin="round" />`;
  }

  return `<polyline points="${x1.toFixed(1)},${y1.toFixed(1)} ${tipX.toFixed(1)},${tipY.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
}

function renderCenteredLabelMarkup(
  text: string,
  cx: number,
  cy: number,
  color: string,
  fontSize = 18,
  fontFamily = 1,
): string {
  const lines = text.split("\n");
  const lineHeight = fontSize * 1.25;
  const startY = cy - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map(
      (line, idx) =>
        `<tspan x="${cx.toFixed(1)}" y="${(startY + idx * lineHeight).toFixed(1)}" dominant-baseline="central">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return `<text text-anchor="middle" fill="${escapeXml(color)}" font-size="${fontSize}" font-family="${escapeXml(fontFamilyStack(fontFamily))}">${tspans}</text>`;
}

export interface RenderExcalidrawSvgOptions {
  dark?: boolean;
  padding?: number;
  background?: boolean;
}

/** Renders an Excalidraw scene into a standalone SVG string. */
export function renderExcalidrawSvg(scene: ExcalidrawDocument, options: RenderExcalidrawSvgOptions = {}): string {
  const dark = Boolean(options.dark);
  const padding = options.padding ?? 24;
  const includeBg = options.background ?? true;
  const active = visibleElements(scene.elements);
  const bounds = getSceneBounds(active);

  const viewMinX = Math.floor(bounds.minX - padding);
  const viewMinY = Math.floor(bounds.minY - padding);
  const viewWidth = Math.ceil(bounds.width + padding * 2);
  const viewHeight = Math.ceil(bounds.height + padding * 2);

  const defs: string[] = [];
  const body: string[] = [];

  if (includeBg) {
    const bgColor = adaptDarkColor(scene.appState?.viewBackgroundColor ?? "#ffffff", dark, true);
    if (bgColor && bgColor !== "transparent") {
      body.push(
        `<rect x="${viewMinX}" y="${viewMinY}" width="${viewWidth}" height="${viewHeight}" fill="${escapeXml(bgColor)}" rx="6" />`,
      );
    }
  }

  const byId = new Map<string, ExcalidrawElement>();
  const boundTextByContainer = new Map<string, ExcalidrawElement>();
  for (const el of active) {
    byId.set(el.id, el);
    if (el.type === "text" && el.containerId) {
      boundTextByContainer.set(el.containerId, el);
    }
  }

  for (const el of active) {
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) {
      // Bound text is rendered centered inside its container shape.
      continue;
    }

    const b = getElementBounds(el);
    const stroke = adaptDarkColor(el.strokeColor ?? "#1e1e1e", dark, false);
    const rawBg = el.backgroundColor ?? "transparent";
    const bg = rawBg === "transparent" ? "none" : adaptDarkColor(rawBg, dark, false);
    const strokeWidth = el.strokeWidth ?? 2;
    const dash = strokeDasharray(el.strokeStyle, strokeWidth);
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
    const opacity = (el.opacity ?? 100) / 100;
    const opacityAttr = opacity < 1 ? ` opacity="${opacity.toFixed(2)}"` : "";
    const angleDeg = el.angle ? (el.angle * 180) / Math.PI : 0;
    const rotateAttr = angleDeg
      ? ` transform="rotate(${angleDeg.toFixed(2)} ${b.cx.toFixed(1)} ${b.cy.toFixed(1)})"`
      : "";

    let fillAttr = `fill="${escapeXml(bg)}"`;
    if (bg !== "none" && (el.fillStyle === "hachure" || el.fillStyle === "cross-hatch")) {
      const patternId = `excalidraw-fill-${el.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
      const cross =
        el.fillStyle === "cross-hatch"
          ? `<line x1="0" y1="0" x2="8" y2="8" stroke="${escapeXml(bg)}" stroke-width="1.5" />`
          : "";
      defs.push(
        `<pattern id="${patternId}" width="8" height="8" patternUnits="userSpaceOnUse">` +
          `<line x1="0" y1="8" x2="8" y2="0" stroke="${escapeXml(bg)}" stroke-width="1.5" />` +
          cross +
          `</pattern>`,
      );
      fillAttr = `fill="url(#${patternId})"`;
    }

    const parts: string[] = [];

    if (el.type === "rectangle") {
      const rx = el.roundness ? Math.min(12, Math.min(b.width, b.height) * 0.18) : 0;
      parts.push(
        `<rect x="${b.minX.toFixed(1)}" y="${b.minY.toFixed(1)}" width="${b.width.toFixed(1)}" height="${b.height.toFixed(1)}" rx="${rx.toFixed(1)}" ${fillAttr} stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}"${dashAttr} />`,
      );
    } else if (el.type === "diamond") {
      const pts = [
        `${b.cx.toFixed(1)},${b.minY.toFixed(1)}`,
        `${b.maxX.toFixed(1)},${b.cy.toFixed(1)}`,
        `${b.cx.toFixed(1)},${b.maxY.toFixed(1)}`,
        `${b.minX.toFixed(1)},${b.cy.toFixed(1)}`,
      ].join(" ");
      parts.push(
        `<polygon points="${pts}" ${fillAttr} stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}" stroke-linejoin="round"${dashAttr} />`,
      );
    } else if (el.type === "ellipse") {
      parts.push(
        `<ellipse cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" rx="${(b.width / 2).toFixed(1)}" ry="${(b.height / 2).toFixed(1)}" ${fillAttr} stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}"${dashAttr} />`,
      );
    } else if (el.type === "frame") {
      const frameTitle = el.name || "Frame";
      parts.push(
        `<text x="${b.minX.toFixed(1)}" y="${(b.minY - 6).toFixed(1)}" fill="${escapeXml(stroke)}" font-size="12" font-family="${escapeXml(fontFamilyStack(2))}" opacity="0.75">${escapeXml(frameTitle)}</text>`,
      );
      parts.push(
        `<rect x="${b.minX.toFixed(1)}" y="${b.minY.toFixed(1)}" width="${b.width.toFixed(1)}" height="${b.height.toFixed(1)}" rx="6" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.5" stroke-opacity="0.55" />`,
      );
    } else if (el.type === "image") {
      const file = el.fileId ? scene.files?.[el.fileId] : undefined;
      if (file?.dataURL && /^data:image\//i.test(file.dataURL)) {
        parts.push(
          `<image x="${b.minX.toFixed(1)}" y="${b.minY.toFixed(1)}" width="${b.width.toFixed(1)}" height="${b.height.toFixed(1)}" href="${escapeXml(file.dataURL)}" preserveAspectRatio="none" />`,
        );
      } else {
        parts.push(
          `<rect x="${b.minX.toFixed(1)}" y="${b.minY.toFixed(1)}" width="${b.width.toFixed(1)}" height="${b.height.toFixed(1)}" rx="4" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.5" stroke-dasharray="4 4" />`,
        );
      }
    } else if (el.type === "arrow" || el.type === "line" || el.type === "freedraw") {
      const pts =
        el.points && el.points.length >= 2
          ? el.points
          : [
              [0, 0],
              [el.width, el.height],
            ];
      const absPts = pts.map(([px, py]) => [el.x + px, el.y + py] as const);
      const ptsAttr = absPts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
      parts.push(
        `<polyline points="${ptsAttr}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dashAttr} />`,
      );
      if (el.type === "arrow" || el.startArrowhead || el.endArrowhead) {
        const first = absPts[0]!;
        const second = absPts[1]!;
        const prev = absPts[absPts.length - 2]!;
        const last = absPts[absPts.length - 1]!;
        parts.push(
          renderArrowheadMarkup(
            el.startArrowhead ?? null,
            first[0],
            first[1],
            second[0],
            second[1],
            stroke,
            strokeWidth,
          ),
        );
        parts.push(
          renderArrowheadMarkup(
            el.endArrowhead !== undefined ? el.endArrowhead : el.type === "arrow" ? "arrow" : null,
            last[0],
            last[1],
            prev[0],
            prev[1],
            stroke,
            strokeWidth,
          ),
        );
      }
    } else if (el.type === "text") {
      const textContent = el.text ?? "";
      if (textContent) {
        const fontSize = el.fontSize ?? 20;
        const lineHeight = fontSize * (el.lineHeight ?? 1.25);
        const lines = textContent.split("\n");
        const align = el.textAlign ?? "left";
        const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
        const anchorX = align === "center" ? b.cx : align === "right" ? b.maxX : b.minX;
        const tspans = lines
          .map(
            (line, idx) =>
              `<tspan x="${anchorX.toFixed(1)}" y="${(b.minY + fontSize + idx * lineHeight).toFixed(1)}">${escapeXml(line)}</tspan>`,
          )
          .join("");
        parts.push(
          `<text text-anchor="${anchor}" fill="${escapeXml(stroke)}" font-size="${fontSize}" font-family="${escapeXml(fontFamilyStack(el.fontFamily))}">${tspans}</text>`,
        );
      }
    }

    const boundText = boundTextByContainer.get(el.id);
    const inlineText = boundText?.text ?? el.label?.text ?? (el.type !== "text" ? el.text : undefined);
    if (inlineText) {
      const labelColor = adaptDarkColor(
        boundText?.strokeColor ?? el.label?.strokeColor ?? el.strokeColor ?? "#1e1e1e",
        dark,
        false,
      );
      const labelSize = boundText?.fontSize ?? el.label?.fontSize ?? 18;
      const labelFont = boundText?.fontFamily ?? el.fontFamily ?? 1;
      if (el.type === "arrow" || el.type === "line") {
        const pts =
          el.points && el.points.length >= 2
            ? el.points
            : [
                [0, 0],
                [el.width, el.height],
              ];
        const midIdx = Math.floor(pts.length / 2);
        const midPt =
          pts.length % 2 === 1
            ? [el.x + pts[midIdx]![0], el.y + pts[midIdx]![1]]
            : [el.x + (pts[midIdx - 1]![0] + pts[midIdx]![0]) / 2, el.y + (pts[midIdx - 1]![1] + pts[midIdx]![1]) / 2];
        parts.push(renderCenteredLabelMarkup(inlineText, midPt[0]!, midPt[1]! - 10, labelColor, labelSize, labelFont));
      } else {
        parts.push(renderCenteredLabelMarkup(inlineText, b.cx, b.cy, labelColor, labelSize, labelFont));
      }
    }

    body.push(`<g data-element-id="${escapeXml(el.id)}"${opacityAttr}${rotateAttr}>${parts.join("")}</g>`);
  }

  const defsBlock = defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewMinX} ${viewMinY} ${viewWidth} ${viewHeight}" width="${viewWidth}" height="${viewHeight}" data-excalidraw="true">${defsBlock}${body.join("")}</svg>`;
}
