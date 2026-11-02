/**
 * Single integration boundary for `@excalidraw/excalidraw`.
 *
 * All direct imports of `@excalidraw/excalidraw` (component, scene restoration,
 * serialization, element helpers, and stylesheet) are consolidated in this
 * module so upgrading `@excalidraw/excalidraw` in future releases only requires
 * updating this adapter.
 */
import { createElement } from "react";
import {
  CaptureUpdateAction,
  Excalidraw as ExcalidrawComponent,
  FONT_FAMILY,
  THEME,
  convertToExcalidrawElements,
  getNonDeletedElements,
  getSceneVersion,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  UIOptions,
} from "@excalidraw/excalidraw/types";

/**
 * Self-host `@excalidraw/excalidraw` font assets from `/fonts/` rather than
 * falling back to `https://esm.sh/@excalidraw/excalidraw@.../dist/prod/`,
 * which is blocked by Tauri's Content-Security-Policy (`font-src 'self' data:`)
 * and breaks offline desktop usage.
 */
export const EXCALIDRAW_ASSET_PATH = "/";

export function ensureExcalidrawAssetPath(): void {
  if (typeof window === "undefined") {
    return;
  }
  const win = window as Window & { EXCALIDRAW_ASSET_PATH?: string };
  if (!win.EXCALIDRAW_ASSET_PATH) {
    win.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
  }
}

ensureExcalidrawAssetPath();

type RestoredDataState = ReturnType<typeof restore>;
type ExcalidrawElementSkeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];

export { CaptureUpdateAction, FONT_FAMILY, THEME };
export type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawProps };

export function ExcalidrawCanvas(props: ExcalidrawProps) {
  ensureExcalidrawAssetPath();
  return createElement(ExcalidrawComponent, props);
}

export type ExcalidrawSceneElement = OrderedExcalidrawElement;

export interface ExcalidrawSceneAppState {
  viewBackgroundColor: string;
  gridSize: number;
  gridStep: number;
  gridModeEnabled: boolean;
  theme?: AppState["theme"];
  name?: string | null;
}

export interface ExcalidrawSceneData {
  type: "excalidraw";
  version: number;
  source: string;
  elements: readonly ExcalidrawSceneElement[];
  appState: Omit<Partial<AppState>, keyof ExcalidrawSceneAppState> & ExcalidrawSceneAppState;
  files: BinaryFiles;
}

export interface ExcalidrawParseResult {
  scene: ExcalidrawSceneData | null;
  error: string | null;
}

export const EXCALIDRAW_SOURCE = "https://openidea.dev";
export const DEFAULT_VIEW_BACKGROUND_COLOR = "#ffffff";
export const DEFAULT_GRID_SIZE = 20;
export const DEFAULT_GRID_STEP = 5;

export const EXCALIDRAW_UI_OPTIONS: UIOptions = {
  canvasActions: {
    changeViewBackgroundColor: true,
    clearCanvas: true,
    export: {
      saveFileToDisk: true,
    },
    loadScene: true,
    saveToActiveFile: false,
    toggleTheme: false,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Expands any shorthand element skeletons (`label: { text: "..." }`) into
 * full Excalidraw container + bound-text elements while preserving standard
 * `.excalidraw` elements untouched so `restore()` retains their IDs and versions.
 */
function expandShorthandElements(rawElements: readonly unknown[]): Record<string, unknown>[] {
  const expanded: Record<string, unknown>[] = [];

  for (let index = 0; index < rawElements.length; index += 1) {
    const entry = rawElements[index];
    if (!isRecord(entry) || typeof entry.type !== "string") {
      continue;
    }

    const label = isRecord(entry.label) && typeof entry.label.text === "string" ? entry.label : null;
    if (!label) {
      const isDimensionlessText =
        entry.type === "text" &&
        typeof entry.text === "string" &&
        (typeof entry.width !== "number" ||
          !Number.isFinite(entry.width) ||
          entry.width <= 0 ||
          typeof entry.height !== "number" ||
          !Number.isFinite(entry.height) ||
          entry.height <= 0);

      if (isDimensionlessText) {
        const { width: _omittedWidth, height: _omittedHeight, ...textSkeleton } = entry;
        try {
          const converted = convertToExcalidrawElements([textSkeleton as unknown as ExcalidrawElementSkeleton], {
            regenerateIds: false,
          });
          expanded.push(...(converted as unknown as Record<string, unknown>[]));
        } catch {
          const fontSize = typeof entry.fontSize === "number" ? entry.fontSize : 20;
          const lines = String(entry.text).split("\n");
          const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 1);
          expanded.push({
            ...entry,
            width: Math.max(20, Math.ceil(longestLine * fontSize * 0.6)),
            height: Math.max(24, Math.ceil(lines.length * fontSize * 1.25)),
          });
        }
      } else {
        expanded.push(entry);
      }
      continue;
    }

    try {
      const converted = convertToExcalidrawElements([entry as unknown as ExcalidrawElementSkeleton], {
        regenerateIds: false,
      });
      expanded.push(...(converted as unknown as Record<string, unknown>[]));
    } catch {
      const containerId = typeof entry.id === "string" && entry.id.trim() ? entry.id : `el-${index + 1}`;
      const textId = `${containerId}-label`;
      const existingBound = Array.isArray(entry.boundElements) ? entry.boundElements.filter(isRecord) : [];
      const { label: _omittedLabel, ...containerRest } = entry;
      const x = typeof entry.x === "number" ? entry.x : 0;
      const y = typeof entry.y === "number" ? entry.y : 0;
      const width = typeof entry.width === "number" ? entry.width : 160;
      const height = typeof entry.height === "number" ? entry.height : 80;
      const fontSize = typeof label.fontSize === "number" ? label.fontSize : 20;
      const lines = String(label.text).split("\n");
      const textHeight = Math.max(24, lines.length * fontSize * 1.25);
      const textWidth = Math.max(40, width - 20);

      expanded.push(
        {
          ...containerRest,
          id: containerId,
          boundElements: [...existingBound, { id: textId, type: "text" }],
        },
        {
          id: textId,
          type: "text",
          x: x + (width - textWidth) / 2,
          y: y + (height - textHeight) / 2,
          width: textWidth,
          height: textHeight,
          text: String(label.text),
          originalText: String(label.text),
          fontSize,
          fontFamily: typeof label.fontFamily === "number" ? label.fontFamily : 1,
          textAlign: typeof label.textAlign === "string" ? label.textAlign : "center",
          verticalAlign: typeof label.verticalAlign === "string" ? label.verticalAlign : "middle",
          containerId,
          lineHeight: 1.25,
          autoResize: true,
        },
      );
    }
  }

  return expanded;
}

function toSceneData(
  restored: RestoredDataState,
  rawAppState: Record<string, unknown> | null,
  source: string,
): ExcalidrawSceneData {
  const viewBackgroundColor =
    typeof rawAppState?.viewBackgroundColor === "string" && rawAppState.viewBackgroundColor.trim()
      ? rawAppState.viewBackgroundColor
      : typeof restored.appState.viewBackgroundColor === "string" && restored.appState.viewBackgroundColor.trim()
        ? restored.appState.viewBackgroundColor
        : DEFAULT_VIEW_BACKGROUND_COLOR;

  const gridSize =
    typeof rawAppState?.gridSize === "number" && Number.isFinite(rawAppState.gridSize) && rawAppState.gridSize > 0
      ? rawAppState.gridSize
      : typeof restored.appState.gridSize === "number" &&
          Number.isFinite(restored.appState.gridSize) &&
          restored.appState.gridSize > 0
        ? restored.appState.gridSize
        : DEFAULT_GRID_SIZE;

  const gridStep =
    typeof rawAppState?.gridStep === "number" && Number.isFinite(rawAppState.gridStep) && rawAppState.gridStep > 0
      ? rawAppState.gridStep
      : typeof restored.appState.gridStep === "number" &&
          Number.isFinite(restored.appState.gridStep) &&
          restored.appState.gridStep > 0
        ? restored.appState.gridStep
        : DEFAULT_GRID_STEP;

  const gridModeEnabled =
    typeof rawAppState?.gridModeEnabled === "boolean"
      ? rawAppState.gridModeEnabled
      : Boolean(restored.appState.gridModeEnabled);

  return {
    type: "excalidraw",
    version: 2,
    source,
    elements: restored.elements,
    appState: {
      ...restored.appState,
      viewBackgroundColor,
      gridSize,
      gridStep,
      gridModeEnabled,
    },
    files: restored.files ?? {},
  };
}

export function createEmptyScene(): ExcalidrawSceneData {
  const restored = restore(
    {
      elements: [],
      appState: {
        viewBackgroundColor: DEFAULT_VIEW_BACKGROUND_COLOR,
        gridSize: DEFAULT_GRID_SIZE,
        gridStep: DEFAULT_GRID_STEP,
        gridModeEnabled: false,
      },
      files: {},
    },
    null,
    null,
    { refreshDimensions: false, repairBindings: true },
  );

  return toSceneData(restored, { gridSize: DEFAULT_GRID_SIZE }, EXCALIDRAW_SOURCE);
}

/**
 * Parses and normalizes a `.excalidraw` JSON string through `@excalidraw/excalidraw`'s
 * official `restore()` pipeline so legacy files, fractional indices, and bound-element
 * repairs stay aligned with upstream Excalidraw across library upgrades.
 */
export function parseExcalidrawScene(raw: string): ExcalidrawParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      scene: createEmptyScene(),
      error: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      scene: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (Array.isArray(parsed)) {
    const expandedElements = expandShorthandElements(parsed);
    const restored = restore(
      {
        elements: expandedElements as unknown as RestoredDataState["elements"],
        appState: {
          viewBackgroundColor: DEFAULT_VIEW_BACKGROUND_COLOR,
          gridSize: DEFAULT_GRID_SIZE,
          gridStep: DEFAULT_GRID_STEP,
          gridModeEnabled: false,
        },
        files: {},
      },
      null,
      null,
      { refreshDimensions: false, repairBindings: true },
    );

    return {
      scene: toSceneData(restored, { gridSize: DEFAULT_GRID_SIZE }, EXCALIDRAW_SOURCE),
      error: null,
    };
  }

  if (!isRecord(parsed)) {
    return {
      scene: null,
      error: "Excalidraw document must be a JSON object or element array.",
    };
  }

  if (
    typeof parsed.type === "string" &&
    parsed.type !== "excalidraw" &&
    parsed.type !== "excalidraw/clipboard" &&
    !Array.isArray(parsed.elements)
  ) {
    return {
      scene: null,
      error: `Unsupported Excalidraw document type: "${parsed.type}".`,
    };
  }

  if ("elements" in parsed && parsed.elements !== undefined && !Array.isArray(parsed.elements)) {
    return {
      scene: null,
      error: '"elements" must be an array when present.',
    };
  }

  const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
  const rawAppState = isRecord(parsed.appState) ? parsed.appState : null;
  const rawFiles = isRecord(parsed.files) ? (parsed.files as unknown as BinaryFiles) : {};
  const source = typeof parsed.source === "string" && parsed.source.trim() ? parsed.source : EXCALIDRAW_SOURCE;

  const expandedElements = expandShorthandElements(rawElements);
  const restored = restore(
    {
      elements: expandedElements as unknown as RestoredDataState["elements"],
      appState: rawAppState as Partial<AppState> | null,
      files: rawFiles,
    },
    null,
    null,
    { refreshDimensions: false, repairBindings: true },
  );

  return {
    scene: toSceneData(restored, rawAppState, source),
    error: null,
  };
}

/**
 * Serializes the scene using `@excalidraw/excalidraw`'s `serializeAsJSON(..., "local")`
 * so saved `.excalidraw` files match the official desktop/web format.
 */
export function serializeExcalidrawScene(
  elementsOrScene: readonly ExcalidrawSceneElement[] | ExcalidrawSceneData,
  appState?: Partial<AppState> | ExcalidrawSceneData["appState"],
  files?: BinaryFiles,
): string {
  if (!Array.isArray(elementsOrScene) && "elements" in elementsOrScene) {
    const scene = elementsOrScene;
    return `${serializeAsJSON(scene.elements, scene.appState as unknown as Partial<AppState>, scene.files, "local")}\n`;
  }

  return `${serializeAsJSON(
    elementsOrScene,
    (appState as unknown as Partial<AppState>) ?? {
      viewBackgroundColor: DEFAULT_VIEW_BACKGROUND_COLOR,
    },
    files ?? {},
    "local",
  )}\n`;
}

/**
 * Returns a lightweight signature representing only the persisted portion of
 * an Excalidraw scene. `onChange` fires on every pointer move, zoom, scroll,
 * or selection change; comparing this signature prevents redundant JSON
 * serialization and CodeMirror transactions on ephemeral UI events.
 */
export function getExcalidrawPersistenceSignature(
  elements: readonly ExcalidrawSceneElement[],
  appState: Partial<AppState> | ExcalidrawSceneData["appState"],
  files: BinaryFiles | undefined,
): string {
  const nonDeleted = getNonDeletedElements(elements);
  const version = getSceneVersion(nonDeleted);
  const fileIds = files ? Object.keys(files).sort().join(",") : "";
  const bg = appState.viewBackgroundColor ?? DEFAULT_VIEW_BACKGROUND_COLOR;
  const gridSize = appState.gridSize ?? DEFAULT_GRID_SIZE;
  const gridStep = appState.gridStep ?? DEFAULT_GRID_STEP;
  const gridMode = Boolean(appState.gridModeEnabled);

  return `${version}:${nonDeleted.length}:${bg}:${gridSize}:${gridStep}:${gridMode}:${fileIds}`;
}

const FONT_FAMILY_NAMES_BY_ID: ReadonlyMap<number, string> = new Map(
  Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]),
);

/**
 * Returns the CSS `font-family` stack used by `@excalidraw/excalidraw` for a
 * numeric `fontFamily` ID (e.g. `1` -> `"Virgil, Segoe UI Emoji"`,
 * `5` -> `"Excalifont, Xiaolai, Segoe UI Emoji"`).
 */
export function getExcalidrawFontFamilyString(fontFamily: number | undefined): string {
  const resolvedId = typeof fontFamily === "number" ? fontFamily : FONT_FAMILY.Virgil;
  const familyName = FONT_FAMILY_NAMES_BY_ID.get(resolvedId);
  if (!familyName) {
    return "Segoe UI Emoji";
  }
  const fallbacks = resolvedId === FONT_FAMILY.Excalifont ? "Xiaolai, Segoe UI Emoji" : "Segoe UI Emoji";
  return `${familyName}, ${fallbacks}`;
}

/**
 * Explicitly loads all `FontFace` instances required by text elements in a scene
 * and invalidates Excalidraw's offscreen text canvas cache (`elementWithCanvasCache`)
 * once the fonts finish loading.
 *
 * Why this is necessary:
 * 1. `@excalidraw/excalidraw` only calls `this.fonts.loadSceneFonts()` once during
 *    `initializeScene` (`initialData`). Subsequent `api.updateScene({ elements })`
 *    calls (such as when `.excalidraw` file contents arrive asynchronously from disk
 *    or CodeMirror) do NOT trigger `document.fonts.load(...)`.
 * 2. In WebKit (`WKWebView` on macOS), `<canvas>` `ctx.fillText` does not
 *    automatically trigger loading of `status: "unloaded"` `FontFace` entries in
 *    `document.fonts`, causing text to render in the fallback system font.
 * 3. Excalidraw caches each text element's rendered offscreen `<canvas>` inside a
 *    `WeakMap` keyed by element object identity (`elementWithCanvasCache`). Cloning
 *    element references after `document.fonts.load(...)` resolves forces Excalidraw
 *    to redraw text elements with the newly loaded glyphs without altering their
 *    `version` or triggering dirty-document writes.
 */
export async function preloadExcalidrawSceneFonts(
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawSceneElement[],
): Promise<boolean> {
  ensureExcalidrawAssetPath();
  if (typeof document === "undefined" || !document.fonts || typeof document.fonts.load !== "function") {
    return false;
  }

  const charsByFontString = new Map<string, Set<string>>();
  for (const element of elements) {
    if (element.isDeleted || element.type !== "text") {
      continue;
    }
    const text = "text" in element && typeof element.text === "string" ? element.text : "";
    if (!text.trim()) {
      continue;
    }
    const fontFamily =
      "fontFamily" in element && typeof element.fontFamily === "number" ? element.fontFamily : undefined;
    const fontString = getExcalidrawFontFamilyString(fontFamily);
    let charSet = charsByFontString.get(fontString);
    if (!charSet) {
      charSet = new Set<string>();
      charsByFontString.set(fontString, charSet);
    }
    for (const ch of Array.from(text)) {
      charSet.add(ch);
    }
  }

  if (charsByFontString.size === 0) {
    return false;
  }

  try {
    const loadedFacesGroups = await Promise.all(
      Array.from(charsByFontString.entries()).map(([fontString, chars]) =>
        document.fonts.load(`16px ${fontString}`, Array.from(chars).join("")),
      ),
    );
    const loadedFontFaces = loadedFacesGroups.flat().filter(Boolean);

    if (typeof document.fonts.dispatchEvent === "function" && typeof Event !== "undefined") {
      try {
        const event = Object.assign(new Event("loadingdone"), {
          fontfaces: loadedFontFaces,
        });
        document.fonts.dispatchEvent(event);
      } catch {
        // Ignore if synthetic FontFaceSet events are unsupported in this environment.
      }
    }

    if (api.getAppState?.()?.isLoading) {
      return true;
    }

    const liveElements =
      typeof api.getSceneElementsIncludingDeleted === "function"
        ? api.getSceneElementsIncludingDeleted()
        : typeof api.getSceneElements === "function"
          ? api.getSceneElements()
          : [];
    const currentElements = liveElements.length > 0 ? liveElements : elements;

    if (currentElements.length > 0) {
      api.updateScene({
        elements: currentElements.map((el) => ({ ...el })),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    api.refresh?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies an externally edited `.excalidraw` scene to a live `ExcalidrawImperativeAPI`
 * instance without resetting the user's current viewport pan/zoom or undo history.
 */
export function syncSceneToImperativeApi(api: ExcalidrawImperativeAPI, scene: ExcalidrawSceneData): void {
  const fileEntries = Object.values(scene.files);
  if (fileEntries.length > 0) {
    api.addFiles(fileEntries);
  }

  api.updateScene({
    elements: scene.elements,
    appState: {
      viewBackgroundColor: scene.appState.viewBackgroundColor,
      gridSize: scene.appState.gridSize ?? DEFAULT_GRID_SIZE,
      gridStep: scene.appState.gridStep,
      gridModeEnabled: scene.appState.gridModeEnabled,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });

  void preloadExcalidrawSceneFonts(api, scene.elements);
}
