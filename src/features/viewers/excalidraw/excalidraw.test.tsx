import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, documentSynced, editorContributions, type EditorDocContext } from "@/editor/api";
import { commands } from "@/platform/ipc";
import { resolveExcalidrawFontsDir } from "../../../../vite.config";
import { ExcalidrawEditor } from "./ExcalidrawEditor";
import {
  EXCALIDRAW_AUTOSAVE_DELAY_MS,
  registerExcalidrawLiveSource,
  useLiveExcalidraw,
  writeExcalidrawSource,
} from "./live";
import * as sceneModule from "./scene";
import {
  CaptureUpdateAction,
  DEFAULT_GRID_STEP,
  DEFAULT_VIEW_BACKGROUND_COLOR,
  EXCALIDRAW_ASSET_PATH,
  FONT_FAMILY,
  getExcalidrawFontFamilyString,
  getExcalidrawPersistenceSignature,
  parseExcalidrawScene,
  preloadExcalidrawSceneFonts,
  serializeExcalidrawScene,
  syncSceneToImperativeApi,
  type AppState,
  type BinaryFiles,
  type ExcalidrawImperativeAPI,
  type ExcalidrawProps,
  type ExcalidrawSceneElement,
} from "./scene";

const currentDir = dirname(fileURLToPath(import.meta.url));

const ctx: EditorDocContext = {
  doc: 1,
  path: "/p/architecture.excalidraw",
  language: "json",
  uiMode: null,
  readOnly: false,
};

describe("Excalidraw official SDK adapter (scene.ts) & upgrade boundary", () => {
  it("isolates all @excalidraw/excalidraw imports strictly inside scene.ts for easy future upgrades", () => {
    const files = readdirSync(currentDir).filter(
      (name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.tsx"),
    );
    expect(files).toContain("scene.ts");

    for (const file of files) {
      const source = readFileSync(join(currentDir, file), "utf8");
      if (file === "scene.ts") {
        expect(source).toContain('from "@excalidraw/excalidraw"');
        expect(source).toContain('import "@excalidraw/excalidraw/index.css"');
      } else {
        expect(source).not.toMatch(/from\s+["']@excalidraw\/excalidraw/);
        expect(source).not.toMatch(/import\s+["']@excalidraw\/excalidraw/);
      }
    }
  });

  it("uses the authentic Excalidraw logo icon in both light and dark fileType SVGs", () => {
    const repoRoot = join(currentDir, "../../../..");
    const lightSvg = readFileSync(join(repoRoot, "src/ui/openidea/fileTypes/excalidraw.svg"), "utf8");
    const darkSvg = readFileSync(join(repoRoot, "src/ui/openidea/fileTypes/excalidraw_dark.svg"), "utf8");

    // Authentic Excalidraw LogoIcon path signature and brand colors
    expect(lightSvg).toContain("M39.9 32.889a.326.326");
    expect(lightSvg).toContain("#6965DB");
    expect(darkSvg).toContain("M39.9 32.889a.326.326");
    expect(darkSvg).toContain("#A8A5FF");
  });

  it("parses empty, standard, shorthand-labeled, and array-based Excalidraw scenes via @excalidraw/excalidraw restore()", () => {
    const empty = parseExcalidrawScene("   ");
    expect(empty.error).toBeNull();
    expect(empty.scene?.elements).toEqual([]);
    expect(empty.scene?.appState.viewBackgroundColor).toBe(DEFAULT_VIEW_BACKGROUND_COLOR);
    expect(empty.scene?.appState.gridStep).toBe(DEFAULT_GRID_STEP);

    const fromArray = parseExcalidrawScene(
      JSON.stringify([
        {
          id: "r1",
          type: "rectangle",
          x: 10,
          y: 20,
          width: 160,
          height: 80,
          label: { text: "Core Service" },
        },
      ]),
    );
    expect(fromArray.error).toBeNull();
    expect(fromArray.scene?.elements.length).toBeGreaterThanOrEqual(2);
    expect(fromArray.scene?.elements.some((el) => el.id === "r1" && el.type === "rectangle")).toBe(true);
    expect(
      fromArray.scene?.elements.some((el) => el.type === "text" && "text" in el && el.text === "Core Service"),
    ).toBe(true);

    const invalid = parseExcalidrawScene("{ bad json");
    expect(invalid.scene).toBeNull();
    expect(invalid.error).toBeTruthy();

    const unsupportedType = parseExcalidrawScene(JSON.stringify({ type: "other-format" }));
    expect(unsupportedType.scene).toBeNull();
    expect(unsupportedType.error).toContain("Unsupported Excalidraw document type");
  });

  it("serializes scenes via @excalidraw/excalidraw serializeAsJSON and computes stable persistence signatures", () => {
    const parsed = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: [
          {
            id: "box-1",
            type: "rectangle",
            x: 40,
            y: 50,
            width: 160,
            height: 80,
            strokeColor: "#1e1e1e",
            backgroundColor: "#a5d8ff",
            fillStyle: "solid",
            version: 3,
          },
        ],
        appState: {
          viewBackgroundColor: "#f8f9fa",
          gridSize: 20,
          gridStep: 5,
          gridModeEnabled: true,
        },
        files: {},
      }),
    );
    expect(parsed.error).toBeNull();
    const scene = parsed.scene!;

    const json = serializeExcalidrawScene(scene);
    const reparsed = parseExcalidrawScene(json);
    expect(reparsed.error).toBeNull();
    expect(reparsed.scene?.elements).toHaveLength(1);
    expect(reparsed.scene?.elements[0]?.id).toBe("box-1");
    expect(reparsed.scene?.appState.viewBackgroundColor).toBe("#f8f9fa");

    const sig1 = getExcalidrawPersistenceSignature(scene.elements, scene.appState, scene.files);
    // Ephemeral viewport changes (scrollX/scrollY/zoom) must not alter the persistence signature
    const sig2 = getExcalidrawPersistenceSignature(
      scene.elements,
      { ...scene.appState, scrollX: 250, scrollY: -120 } as Partial<AppState>,
      scene.files,
    );
    expect(sig1).toBe(sig2);

    // Changing persisted background color changes the signature
    const sig3 = getExcalidrawPersistenceSignature(
      scene.elements,
      { ...scene.appState, viewBackgroundColor: "#ffffff" },
      scene.files,
    );
    expect(sig3).not.toBe(sig1);

    // Syncing scene to imperative API forwards files and updates scene with CaptureUpdateAction.NEVER
    const addFiles = vi.fn();
    const updateScene = vi.fn();
    const mockApi = {
      addFiles,
      updateScene,
    } as unknown as ExcalidrawImperativeAPI;

    syncSceneToImperativeApi(mockApi, scene);
    expect(updateScene).toHaveBeenCalledWith({
      elements: scene.elements,
      appState: {
        viewBackgroundColor: "#f8f9fa",
        gridSize: 20,
        gridStep: 5,
        gridModeEnabled: true,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  });

  it("self-hosts Excalidraw font assets from '/' and ensures Tauri CSP allows local font loading", () => {
    const win = window as Window & { EXCALIDRAW_ASSET_PATH?: string };
    expect(EXCALIDRAW_ASSET_PATH).toBe("/");
    expect(win.EXCALIDRAW_ASSET_PATH).toBe("/");

    const fontsDir = resolveExcalidrawFontsDir();
    expect(existsSync(fontsDir)).toBe(true);
    const fontFamilies = readdirSync(fontsDir);
    expect(fontFamilies).toEqual(
      expect.arrayContaining(["Virgil", "Excalifont", "Cascadia", "ComicShanns", "Liberation", "Nunito"]),
    );

    const repoRoot = join(currentDir, "../../../..");
    const tauriConf = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8")) as {
      app?: { security?: { csp?: string } };
    };
    const csp = tauriConf.app?.security?.csp ?? "";
    expect(csp).toMatch(/font-src[^;]*'self'/);
    expect(csp).toMatch(/connect-src[^;]*'self'/);
  });

  it("expands standalone shorthand text elements that omit positive width/height", () => {
    const raw = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [
        {
          id: "title-text",
          type: "text",
          x: 100,
          y: 40,
          text: "Architecture Overview\nSubheading",
          fontSize: 24,
          fontFamily: FONT_FAMILY.Excalifont,
        },
      ],
    });

    const parsed = parseExcalidrawScene(raw);
    expect(parsed.error).toBeNull();
    const textEl = parsed.scene?.elements.find((el) => el.id === "title-text");
    expect(textEl).toBeDefined();
    expect(textEl?.type).toBe("text");
    expect(textEl?.width).toBeGreaterThan(0);
    expect(textEl?.height).toBeGreaterThan(0);
  });

  it("preloads required scene FontFaces and invalidates Excalidraw's element canvas cache on completion", async () => {
    expect(getExcalidrawFontFamilyString(FONT_FAMILY.Virgil)).toBe("Virgil, Segoe UI Emoji");
    expect(getExcalidrawFontFamilyString(FONT_FAMILY.Excalifont)).toBe("Excalifont, Xiaolai, Segoe UI Emoji");
    expect(getExcalidrawFontFamilyString(FONT_FAMILY.Cascadia)).toBe("Cascadia, Segoe UI Emoji");

    const parsed = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [
          {
            id: "text-1",
            type: "text",
            x: 20,
            y: 30,
            width: 140,
            height: 25,
            text: "Hello Diagram",
            fontSize: 20,
            fontFamily: FONT_FAMILY.Excalifont,
          },
          {
            id: "text-2",
            type: "text",
            x: 20,
            y: 70,
            width: 120,
            height: 25,
            text: "const x = 1;",
            fontSize: 16,
            fontFamily: FONT_FAMILY.Cascadia,
          },
        ],
      }),
    );
    const scene = parsed.scene!;
    const originalElementRef = scene.elements[0]!;

    const loadMock = vi.fn().mockResolvedValue([{} as FontFace]);
    const dispatchEventMock = vi.fn();
    const originalFonts = document.fonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        load: loadMock,
        dispatchEvent: dispatchEventMock,
      },
    });

    try {
      const updateScene = vi.fn();
      const refresh = vi.fn();
      const mockApi = {
        getSceneElementsIncludingDeleted: () => scene.elements,
        updateScene,
        refresh,
      } as unknown as ExcalidrawImperativeAPI;

      const loaded = await preloadExcalidrawSceneFonts(mockApi, scene.elements);
      expect(loaded).toBe(true);
      expect(loadMock).toHaveBeenCalledTimes(2);
      expect(loadMock).toHaveBeenCalledWith("16px Excalifont, Xiaolai, Segoe UI Emoji", expect.stringContaining("H"));
      expect(loadMock).toHaveBeenCalledWith("16px Cascadia, Segoe UI Emoji", expect.stringContaining("c"));
      expect(dispatchEventMock).toHaveBeenCalledTimes(1);

      expect(updateScene).toHaveBeenCalledTimes(1);
      const updatedCall = updateScene.mock.calls[0]?.[0] as {
        elements: ExcalidrawSceneElement[];
        captureUpdate: typeof CaptureUpdateAction.NEVER;
      };
      expect(updatedCall.captureUpdate).toBe(CaptureUpdateAction.NEVER);
      // Cloned element reference invalidates Excalidraw's WeakMap<ExcalidrawElement, OffscreenCanvas>
      expect(updatedCall.elements[0]).not.toBe(originalElementRef);
      expect(updatedCall.elements[0]).toEqual(originalElementRef);
      // Cloning must not alter persistence signature
      expect(getExcalidrawPersistenceSignature(updatedCall.elements, scene.appState, scene.files)).toBe(
        getExcalidrawPersistenceSignature(scene.elements, scene.appState, scene.files),
      );
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: originalFonts,
      });
    }
  });
});

describe("ExcalidrawEditor and live CodeMirror synchronization", () => {
  const disposers: Array<() => void> = [];
  const views: EditorView[] = [];
  let latestCanvasProps: ExcalidrawProps | null = null;
  let mockImperativeApi: {
    addFiles: ReturnType<typeof vi.fn>;
    updateScene: ReturnType<typeof vi.fn>;
  } | null = null;

  beforeEach(() => {
    disposers.push(registerExcalidrawLiveSource());
    latestCanvasProps = null;
    mockImperativeApi = {
      addFiles: vi.fn(),
      updateScene: vi.fn(),
    };

    const spy = vi.spyOn(sceneModule, "ExcalidrawCanvas").mockImplementation((props: ExcalidrawProps) => {
      latestCanvasProps = props;
      return (
        <div
          data-testid="excalidraw-sdk-canvas"
          data-theme={props.theme}
          data-element-count={
            props.initialData && "elements" in props.initialData ? (props.initialData.elements?.length ?? 0) : 0
          }
        />
      );
    });
    disposers.push(() => spy.mockRestore());
  });

  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    useLiveExcalidraw.setState({}, true);
  });

  it("synchronizes changes bidirectionally between CodeMirror and the Excalidraw SDK canvas", () => {
    const initialScene = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://openidea.dev",
        elements: [
          {
            id: "rect-1",
            type: "rectangle",
            x: 20,
            y: 20,
            width: 140,
            height: 70,
            version: 1,
          },
        ],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    ).scene!;

    const live = editorContributions().find((c) => c.id === "viewers.excalidrawLive")!;
    const view = new EditorView({
      state: EditorState.create({
        doc: serializeExcalidrawScene(initialScene),
        extensions: [live.extensions(ctx)],
      }),
    });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    views.push(view);

    render(
      <ExcalidrawEditor path={ctx.path} tabId="tab-1">
        <div data-testid="cm-child" />
      </ExcalidrawEditor>,
    );

    const canvasRegion = screen.getByRole("region", { name: "Excalidraw canvas" });
    expect(canvasRegion).toBeTruthy();
    expect(screen.getByTestId("excalidraw-sdk-canvas").getAttribute("data-element-count")).toBe("1");

    // Attach the imperative API handle as @excalidraw/excalidraw does on mount
    act(() => {
      latestCanvasProps?.excalidrawAPI?.(mockImperativeApi as unknown as ExcalidrawImperativeAPI);
    });

    // 1. Canvas -> CodeMirror: simulate user drawing a new element on the Excalidraw canvas
    const updatedFromCanvas = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://openidea.dev",
        elements: [
          {
            id: "rect-1",
            type: "rectangle",
            x: 20,
            y: 20,
            width: 140,
            height: 70,
            version: 2,
          },
          {
            id: "ellipse-2",
            type: "ellipse",
            x: 220,
            y: 40,
            width: 100,
            height: 60,
            version: 1,
          },
        ],
        appState: { viewBackgroundColor: "#eef2ff" },
        files: {},
      }),
    ).scene!;

    act(() => {
      latestCanvasProps?.onChange?.(
        updatedFromCanvas.elements as readonly ExcalidrawSceneElement[],
        updatedFromCanvas.appState as AppState,
        updatedFromCanvas.files as BinaryFiles,
      );
    });

    const docAfterCanvasEdit = JSON.parse(view.state.doc.toString());
    expect(docAfterCanvasEdit.elements).toHaveLength(2);
    expect(docAfterCanvasEdit.appState.viewBackgroundColor).toBe("#eef2ff");
    // Canvas-originated changes must not loop back into updateScene
    expect(mockImperativeApi?.updateScene).not.toHaveBeenCalled();

    // 2. CodeMirror -> Canvas: external JSON edit updates the live Excalidraw imperative API
    const externalScene = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://openidea.dev",
        elements: [
          {
            id: "diamond-3",
            type: "diamond",
            x: 80,
            y: 90,
            width: 120,
            height: 120,
            version: 5,
          },
        ],
        appState: { viewBackgroundColor: "#fff9db" },
        files: {},
      }),
    ).scene!;

    act(() => {
      writeExcalidrawSource(ctx.path, serializeExcalidrawScene(externalScene));
    });

    expect(mockImperativeApi?.updateScene).toHaveBeenCalledTimes(1);
    expect(mockImperativeApi?.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: expect.arrayContaining([expect.objectContaining({ id: "diamond-3" })]),
        appState: expect.objectContaining({ viewBackgroundColor: "#fff9db" }),
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );

    // 3. Invalid JSON shows error banner and Reset button restores a valid empty diagram
    act(() => {
      writeExcalidrawSource(ctx.path, "{ broken json");
    });
    expect(screen.getByRole("alert").textContent).toContain("Invalid Excalidraw JSON");

    fireEvent.click(screen.getByRole("button", { name: "Reset to Empty Diagram" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(JSON.parse(view.state.doc.toString()).elements).toEqual([]);
  });

  it("autosaves canvas edits after debounce and immediately on blur once document sync completes", async () => {
    vi.useFakeTimers();
    const docSaveSpy = vi.spyOn(commands, "docSave").mockResolvedValue({ status: "ok", data: null });
    disposers.push(() => {
      docSaveSpy.mockRestore();
      vi.useRealTimers();
    });

    const syncedSpy = vi.fn().mockResolvedValue(undefined);
    const initialScene = parseExcalidrawScene(serializeExcalidrawScene(sceneModule.createEmptyScene())).scene!;
    const live = editorContributions().find((c) => c.id === "viewers.excalidrawLive")!;
    const view = new EditorView({
      state: EditorState.create({
        doc: serializeExcalidrawScene(initialScene),
        extensions: [documentSynced.of(syncedSpy), live.extensions(ctx)],
      }),
    });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    views.push(view);

    render(
      <ExcalidrawEditor path={ctx.path} tabId="tab-autosave">
        <div data-testid="cm-child" />
      </ExcalidrawEditor>,
    );

    const editedScene = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://openidea.dev",
        elements: [
          {
            id: "autosave-rect-1",
            type: "rectangle",
            x: 30,
            y: 40,
            width: 140,
            height: 80,
            version: 2,
          },
        ],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    ).scene!;

    act(() => {
      latestCanvasProps?.onChange?.(
        editedScene.elements as readonly ExcalidrawSceneElement[],
        { ...editedScene.appState, isLoading: false } as AppState,
        editedScene.files as BinaryFiles,
      );
    });

    expect(docSaveSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(EXCALIDRAW_AUTOSAVE_DELAY_MS);
    });

    expect(syncedSpy).toHaveBeenCalledTimes(1);
    expect(docSaveSpy).toHaveBeenCalledTimes(1);
    expect(docSaveSpy).toHaveBeenCalledWith(ctx.doc);
  });

  it("does not mount an empty canvas or reset existing file content when restored at startup before CodeMirror mounts", () => {
    const savedScene = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: [
          {
            id: "restored-rect-1",
            type: "rectangle",
            x: 120,
            y: 80,
            width: 220,
            height: 130,
            version: 12,
          },
        ],
        appState: {
          gridSize: null,
          viewBackgroundColor: "#ffffff",
        },
        files: {},
      }),
    ).scene!;
    const savedJson = serializeExcalidrawScene(savedScene);

    // 1. On app restart / session restore, ExcalidrawEditor renders before TextEditorHost
    // has finished opening the backend document and mounting the CodeMirror EditorView.
    render(
      <ExcalidrawEditor path={ctx.path} tabId="tab-restore">
        <div data-testid="cm-child" />
      </ExcalidrawEditor>,
    );

    // Canvas must NOT mount with a synthetic empty scene while document text is still loading.
    expect(screen.queryByTestId("excalidraw-sdk-canvas")).toBeNull();
    expect(useLiveExcalidraw.getState()[ctx.path]).toBeUndefined();

    // 2. CodeMirror EditorView finishes mounting with the saved file content from disk.
    const live = editorContributions().find((c) => c.id === "viewers.excalidrawLive")!;
    let view!: EditorView;
    act(() => {
      view = new EditorView({
        state: EditorState.create({
          doc: savedJson,
          extensions: [live.extensions(ctx)],
        }),
      });
    });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    views.push(view);

    // Now the canvas mounts with the restored element from disk.
    expect(screen.getByTestId("excalidraw-sdk-canvas").getAttribute("data-element-count")).toBe("1");

    // 3. Simulate @excalidraw/excalidraw's initial onChange after initializeScene() normalizes gridSize to 20.
    act(() => {
      latestCanvasProps?.excalidrawAPI?.(mockImperativeApi as unknown as ExcalidrawImperativeAPI);
      latestCanvasProps?.onChange?.(
        savedScene.elements as readonly ExcalidrawSceneElement[],
        { ...savedScene.appState, gridSize: 20, isLoading: false } as AppState,
        savedScene.files as BinaryFiles,
      );
    });

    // The underlying CodeMirror document must still contain the restored rectangle and match savedJson.
    expect(view.state.doc.toString()).toBe(savedJson);
    expect(JSON.parse(view.state.doc.toString()).elements).toHaveLength(1);
    expect(JSON.parse(view.state.doc.toString()).elements[0].id).toBe("restored-rect-1");
  });

  it("defers external scene sync while Excalidraw is still running initializeScene (isLoading: true)", () => {
    const initialScene = parseExcalidrawScene(serializeExcalidrawScene(sceneModule.createEmptyScene())).scene!;
    const live = editorContributions().find((c) => c.id === "viewers.excalidrawLive")!;
    const view = new EditorView({
      state: EditorState.create({
        doc: serializeExcalidrawScene(initialScene),
        extensions: [live.extensions(ctx)],
      }),
    });
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => _removeEditor(handle));
    views.push(view);

    render(
      <ExcalidrawEditor path={ctx.path} tabId="tab-loading-race">
        <div data-testid="cm-child" />
      </ExcalidrawEditor>,
    );

    let isLoading = true;
    const loadingAwareApi = {
      addFiles: vi.fn(),
      updateScene: vi.fn(),
      getAppState: () => ({ isLoading }) as AppState,
    };

    act(() => {
      latestCanvasProps?.excalidrawAPI?.(loadingAwareApi as unknown as ExcalidrawImperativeAPI);
    });

    const loadedDiskScene = parseExcalidrawScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://openidea.dev",
        elements: [
          {
            id: "disk-node-1",
            type: "rectangle",
            x: 50,
            y: 60,
            width: 180,
            height: 90,
            version: 4,
          },
        ],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    ).scene!;
    const loadedDiskJson = serializeExcalidrawScene(loadedDiskScene);

    // External update arrives while Excalidraw's async initializeScene() is still in flight (isLoading = true).
    act(() => {
      writeExcalidrawSource(ctx.path, loadedDiskJson);
    });
    expect(loadingAwareApi.updateScene).not.toHaveBeenCalled();

    // Excalidraw's initializeScene() completes with the stale initial empty scene and fires onChange.
    isLoading = false;
    act(() => {
      latestCanvasProps?.onChange?.(
        initialScene.elements as readonly ExcalidrawSceneElement[],
        { ...initialScene.appState, isLoading: false } as AppState,
        initialScene.files as BinaryFiles,
      );
    });

    // Instead of overwriting CodeMirror with the stale empty initialData, ExcalidrawEditor
    // pushes the pending loadedDiskScene into the now-initialized canvas.
    expect(JSON.parse(view.state.doc.toString()).elements).toHaveLength(1);
    expect(JSON.parse(view.state.doc.toString()).elements[0].id).toBe("disk-node-1");
    expect(loadingAwareApi.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: expect.arrayContaining([expect.objectContaining({ id: "disk-node-1" })]),
        captureUpdate: CaptureUpdateAction.NEVER,
      }),
    );
  });
});
