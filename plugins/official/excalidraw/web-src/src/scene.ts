/**
 * The one module that talks to `@excalidraw/excalidraw`'s data API: reading a
 * `.excalidraw` file into a scene (through Excalidraw's own `restore`, so old
 * files and element skeletons work), writing it back in the format
 * Excalidraw saves, and showing a scene that changed in the text.
 */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getNonDeletedElements,
  getSceneVersion,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SceneCodec } from "./sync";

export interface Scene {
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  /** The file's `source`, kept as it was. */
  source?: string;
}

/** `source` of files that had none (Excalidraw would write the page's address). */
export const SOURCE = "https://openidea.dev";

type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Hand-written or generated files often hold element skeletons
 * (`{ type: "rectangle", x, y, label: { text } }`) rather than full elements:
 * expand those, keep full elements (their ids and versions) as they are.
 */
function expandSkeletons(raw: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.type !== "string") continue;
    const skeleton = "label" in entry || typeof entry.seed !== "number";
    if (!skeleton) {
      out.push(entry);
      continue;
    }
    try {
      out.push(...convertToExcalidrawElements([entry as unknown as Skeleton], { regenerateIds: false }));
    } catch {
      out.push(entry);
    }
  }
  return out;
}

export function parseScene(text: string): { scene: Scene } | { error: string } {
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (Array.isArray(data)) data = { elements: data };
  if (!isRecord(data)) return { error: "An Excalidraw file is a JSON object (or an array of elements)." };
  if (typeof data.type === "string" && !data.type.startsWith("excalidraw"))
    return { error: `Not an Excalidraw file: its "type" is "${data.type}".` };
  if (data.elements !== undefined && !Array.isArray(data.elements)) return { error: '"elements" must be an array.' };
  const restored = restore(
    {
      elements: expandSkeletons((data.elements as unknown[]) ?? []) as never,
      appState: (isRecord(data.appState) ? data.appState : {}) as Partial<AppState>,
      files: (isRecord(data.files) ? data.files : {}) as BinaryFiles,
    },
    null,
    null,
    { refreshDimensions: false, repairBindings: true },
  );
  // The page's own address (what Excalidraw writes here) is no source worth keeping.
  const own = /^(openidea-plugin:|https?:\/\/openidea-plugin\.localhost)/;
  const source =
    typeof data.source === "string" && data.source.trim() && !own.test(data.source) ? data.source : undefined;
  return { scene: { elements: restored.elements, appState: restored.appState, files: restored.files ?? {}, source } };
}

/**
 * As Excalidraw saves to disk (`serializeAsJSON(…, "local")`), with a final
 * newline, keeping the file's `source`: Excalidraw writes the page's origin,
 * which here is the IDE's internal plugin URL.
 */
export function serializeScene(scene: Scene): string {
  const json = serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
  const source = JSON.stringify(scene.source ?? SOURCE);
  // `source` is the third key, before any element: the first match is the file's own.
  return `${json.replace(/"source": "(?:[^"\\]|\\.)*"/, `"source": ${source}`)}\n`;
}

/** What is saved changes iff this does: pointer moves, zoom and selection don't. */
export function sceneSignature(scene: Scene): string {
  const elements = getNonDeletedElements(scene.elements);
  const a = scene.appState;
  const files = Object.keys(scene.files).sort().join(",");
  return [
    getSceneVersion(elements),
    elements.length,
    a.viewBackgroundColor,
    a.gridSize,
    a.gridStep,
    a.gridModeEnabled,
    files,
  ].join(":");
}

export const codec: SceneCodec<Scene> = { parse: parseScene, serialize: serializeScene, signature: sceneSignature };

/** Shows a scene the text changed to, keeping the view (scroll, zoom) and the canvas's undo history. */
export function applyScene(api: ExcalidrawImperativeAPI, scene: Scene) {
  const files = Object.values(scene.files);
  if (files.length) api.addFiles(files);
  const { viewBackgroundColor, gridSize, gridStep, gridModeEnabled } = scene.appState;
  const appState: Pick<AppState, "viewBackgroundColor" | "gridSize" | "gridStep" | "gridModeEnabled"> = {
    viewBackgroundColor: viewBackgroundColor ?? "#ffffff",
    gridSize: gridSize ?? 20,
    gridStep: gridStep ?? 5,
    gridModeEnabled: gridModeEnabled ?? false,
  };
  api.updateScene({ elements: scene.elements, appState, captureUpdate: CaptureUpdateAction.NEVER });
  void loadSceneFonts(api);
}

/**
 * Excalidraw loads the fonts of the scene it starts with, not of scenes set
 * later, and WebKit's canvas doesn't load a font by drawing with it: load
 * them, then redraw text (new element objects drop Excalidraw's cached text
 * canvases) without recording a change.
 */
export async function loadSceneFonts(api: ExcalidrawImperativeAPI) {
  const fonts = new Set<string>();
  for (const el of api.getSceneElements()) {
    if (el.type === "text") fonts.add(`${el.fontSize}px ${fontStack(el.fontFamily)}`);
  }
  if (!fonts.size || !document.fonts?.load) return;
  await Promise.allSettled([...fonts].map((f) => document.fonts.load(f)));
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((el) => ({ ...el })),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

/** Excalidraw's font family ids (`FONT_FAMILY`) → their CSS stack. */
function fontStack(id: number): string {
  const names: Record<number, string> = {
    1: "Virgil",
    2: "Helvetica",
    3: "Cascadia",
    5: "Excalifont, Xiaolai",
    6: "Nunito",
    7: "Lilita One",
    8: "Comic Shanns",
    9: "Liberation Sans",
  };
  return `${names[id] ?? "Excalifont, Xiaolai"}, Segoe UI Emoji`;
}

/** What exports are called: the file's name without its extension. */
export function exportName(file: string): string {
  return file.replace(/\.excalidraw(\.json)?$/i, "") || "drawing";
}
