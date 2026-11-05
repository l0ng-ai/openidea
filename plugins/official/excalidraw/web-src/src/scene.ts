/**
 * The one module that talks to `@excalidraw/excalidraw`'s data API: reading a
 * `.excalidraw` / `.excalidraw.svg` file into a scene (through Excalidraw's
 * own `restore`, so old files and element skeletons work), writing it back in
 * the format Excalidraw saves, and showing a scene that changed in the text.
 */
import {
  CaptureUpdateAction,
  MIME_TYPES,
  convertToExcalidrawElements,
  exportToSvg,
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

export const isSvgFile = (name = ""): boolean => /\.svg$/i.test(name);

function byteStringToBytes(bstring: string): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(bstring.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < bstring.length; i++) view[i] = bstring.charCodeAt(i);
  return view;
}

function bytesToByteString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

async function inflateBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(bytes).then(() => writer.close());
  const textPromise = new Response(ds.readable).text();
  const [, text] = await Promise.all([writePromise, textPromise]);
  return text;
}

async function deflateString(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const writePromise = writer.write(bytes).then(() => writer.close());
  const bufPromise = new Response(cs.readable).arrayBuffer();
  const [, buf] = await Promise.all([writePromise, bufPromise]);
  return new Uint8Array(buf);
}

/** Encodes a scene JSON string into Excalidraw's `payload-version:2` base64 metadata payload. */
export async function encodeSvgPayload(json: string): Promise<string> {
  const compressed = await deflateString(json);
  const envelope = {
    version: "1",
    encoding: "bstring",
    compressed: true,
    encoded: bytesToByteString(compressed),
  };
  return btoa(JSON.stringify(envelope));
}

/** Extracts and decodes the embedded Excalidraw JSON string from an `.excalidraw.svg` document. */
export async function decodeSvgPayload(svg: string): Promise<{ json: string } | { error: string }> {
  if (!svg.includes(`payload-type:${MIME_TYPES.excalidraw}`)) {
    return { error: "This SVG does not contain an embedded Excalidraw scene." };
  }
  const match = /<!--\s*payload-start\s*-->\s*([\s\S]+?)\s*<!--\s*payload-end\s*-->/.exec(svg);
  if (!match?.[1]) {
    return { error: "Malformed Excalidraw SVG metadata payload." };
  }
  const version = /<!--\s*payload-version:(\d+)\s*-->/.exec(svg)?.[1] ?? "1";
  const isByteString = version !== "1";
  try {
    const decodedBase64 = atob(match[1].replace(/\s+/g, ""));
    const outerJson = isByteString ? decodedBase64 : new TextDecoder("utf-8").decode(byteStringToBytes(decodedBase64));
    const envelope: unknown = JSON.parse(outerJson);
    if (!isRecord(envelope)) return { error: "Invalid Excalidraw SVG metadata payload." };
    if (!("encoded" in envelope)) {
      if (envelope.type === "excalidraw") return { json: outerJson };
      return { error: "Invalid Excalidraw SVG metadata payload." };
    }
    if (envelope.encoding !== "bstring" || typeof envelope.encoded !== "string") {
      return { error: `Unsupported Excalidraw SVG payload encoding: ${String(envelope.encoding)}` };
    }
    const bytes = byteStringToBytes(envelope.encoded);
    const json = envelope.compressed ? await inflateBytes(bytes) : new TextDecoder("utf-8").decode(bytes);
    return { json };
  } catch (e) {
    return { error: e instanceof Error && e.message ? e.message : "Cannot decode Excalidraw SVG scene data." };
  }
}

/** Reads an `.excalidraw.svg` document (or an empty new file) into a scene. */
export async function parseSvgScene(text: string): Promise<{ scene: Scene } | { error: string }> {
  const trimmed = text.trim();
  if (!trimmed) return parseScene("");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseScene(trimmed);
  const decoded = await decodeSvgPayload(trimmed);
  if ("error" in decoded) return decoded;
  return parseScene(decoded.json);
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

/** As Excalidraw exports `.excalidraw.svg` with the scene embedded in `<metadata>`. */
export async function serializeSvgScene(scene: Scene): Promise<string> {
  const elements = getNonDeletedElements(scene.elements);
  const [svg, payload] = await Promise.all([
    exportToSvg({
      elements,
      appState: {
        ...scene.appState,
        exportBackground: scene.appState.exportBackground ?? true,
        viewBackgroundColor: scene.appState.viewBackgroundColor ?? "#ffffff",
        exportWithDarkMode: scene.appState.exportWithDarkMode ?? false,
        exportEmbedScene: true,
      },
      files: scene.files,
      skipInliningFonts: true,
    }),
    encodeSvgPayload(serializeScene(scene).trimEnd()),
  ]);
  return svg.outerHTML.replace(/(<!--\s*payload-start\s*-->)[\s\S]*?(<!--\s*payload-end\s*-->)/, `$1${payload}$2`);
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

export const codec: SceneCodec<Scene> = {
  parse: (text, name) => (isSvgFile(name) || text.trimStart().startsWith("<") ? parseSvgScene(text) : parseScene(text)),
  serialize: (scene, name) => (isSvgFile(name) ? serializeSvgScene(scene) : serializeScene(scene)),
  signature: sceneSignature,
};

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
  return file.replace(/\.excalidraw(\.(json|svg))?$/i, "") || "drawing";
}
