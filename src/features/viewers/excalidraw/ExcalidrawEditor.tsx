/**
 * Excalidraw editor wrapper: hosts the official `@excalidraw/excalidraw`
 * interactive whiteboard backed by OpenIDEA's document sync and autosave.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
} from "react";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Icon, T } from "@/ui";
import { flushExcalidrawAutoSave, getExcalidrawSource, useLiveExcalidraw, writeExcalidrawSource } from "./live";
import {
  DEFAULT_GRID_SIZE,
  EXCALIDRAW_UI_OPTIONS,
  ExcalidrawCanvas,
  THEME,
  createEmptyScene,
  getExcalidrawPersistenceSignature,
  parseExcalidrawScene,
  preloadExcalidrawSceneFonts,
  serializeExcalidrawScene,
  syncSceneToImperativeApi,
  type AppState,
  type BinaryFiles,
  type ExcalidrawImperativeAPI,
  type ExcalidrawSceneElement,
} from "./scene";
import styles from "./Excalidraw.module.css";

interface Props {
  path: string;
  tabId: string;
  actionsInTabs?: boolean;
  children: ReactNode;
}

function readIsDarkTheme(): boolean {
  if (typeof document === "undefined") return true;
  const { themeMode, theme } = document.documentElement.dataset;
  if (themeMode) return themeMode === "dark";
  if (theme) return !theme.includes("light");
  return true;
}

function subscribeThemeMode(cb: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-mode", "data-color-theme", "data-plugin-theme"],
  });
  return () => observer.disconnect();
}

export function ExcalidrawEditor({ path, children }: Props) {
  const isDark = useSyncExternalStore(subscribeThemeMode, readIsDarkTheme, () => true);

  const liveText = useLiveExcalidraw((s) => s[path]?.text);
  const [fallback, setFallback] = useState<{ path: string; text: string } | null>(null);
  const fallbackText = fallback?.path === path ? fallback.text : undefined;
  const rawText = liveText !== undefined ? liveText : fallbackText;

  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const lastCommittedTextRef = useRef<string | null>(null);
  const lastSyncedTextRef = useRef<string | null>(null);
  const lastSignatureRef = useRef<string | null>(null);
  const preloadedApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const pendingExternalSyncRef = useRef<boolean>(false);
  const latestRawTextRef = useRef<string | undefined>(rawText);
  const parsed = useMemo(() => (rawText !== undefined ? parseExcalidrawScene(rawText) : null), [rawText]);
  const scene = parsed?.scene ?? null;
  const latestSceneRef = useRef(scene);

  useEffect(() => {
    latestRawTextRef.current = rawText;
    latestSceneRef.current = scene;
  }, [rawText, scene]);

  useEffect(() => {
    lastCommittedTextRef.current = null;
    lastSyncedTextRef.current = null;
    lastSignatureRef.current = null;
    pendingExternalSyncRef.current = false;
    let cancelled = false;
    if (getExcalidrawSource(path) === undefined) {
      call(commands.fsReadText(path))
        .then((content) => {
          if (!cancelled && getExcalidrawSource(path) === undefined) {
            setFallback({ path, text: content });
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      void flushExcalidrawAutoSave(path);
    };
  }, [path]);

  // Do not mount `<ExcalidrawCanvas>` until the file's text has actually loaded
  // from either CodeMirror (`liveText`) or disk (`fallbackText`). `@excalidraw/excalidraw`
  // wraps its component in `React.memo` that ignores `initialData` prop updates
  // and runs `initializeScene()` asynchronously on mount; mounting prematurely
  // with an empty fallback would cause `initializeScene()` to reset the scene to `[]`.
  const canRenderCanvas = rawText !== undefined && !parsed?.error;
  const [canvasInit, setCanvasInit] = useState<{
    path: string;
    rawText: string;
    signature: string;
    data: {
      elements: readonly ExcalidrawSceneElement[];
      appState: {
        viewBackgroundColor: string;
        gridSize: number;
        gridStep: number;
        gridModeEnabled: boolean;
      };
      files: BinaryFiles;
    };
  } | null>(null);

  if (!canRenderCanvas) {
    if (canvasInit !== null) {
      setCanvasInit(null);
    }
  } else if (canvasInit?.path !== path) {
    const base = scene ?? createEmptyScene();
    setCanvasInit({
      path,
      rawText,
      signature: getExcalidrawPersistenceSignature(base.elements, base.appState, base.files),
      data: {
        elements: base.elements,
        appState: {
          viewBackgroundColor: base.appState.viewBackgroundColor,
          gridSize: base.appState.gridSize ?? DEFAULT_GRID_SIZE,
          gridStep: base.appState.gridStep,
          gridModeEnabled: base.appState.gridModeEnabled,
        },
        files: base.files,
      },
    });
  }

  useEffect(() => {
    if (!canvasInit) {
      lastCommittedTextRef.current = null;
      lastSyncedTextRef.current = null;
      lastSignatureRef.current = null;
      pendingExternalSyncRef.current = false;
      return;
    }
    if (lastSignatureRef.current === null) {
      lastCommittedTextRef.current = null;
      lastSyncedTextRef.current = canvasInit.rawText;
      lastSignatureRef.current = canvasInit.signature;
      pendingExternalSyncRef.current = false;
    }
  }, [canvasInit]);

  // Synchronize external JSON edits (such as disk reload or undo) into the live
  // Excalidraw canvas without clobbering changes that originated from the canvas.
  useEffect(() => {
    if (!excalidrawAPI || !scene || rawText === undefined) return;
    if (rawText === lastCommittedTextRef.current || rawText === lastSyncedTextRef.current) {
      if (preloadedApiRef.current !== excalidrawAPI) {
        preloadedApiRef.current = excalidrawAPI;
        void preloadExcalidrawSceneFonts(excalidrawAPI, scene.elements);
      }
      return;
    }

    const nextSignature = getExcalidrawPersistenceSignature(scene.elements, scene.appState, scene.files);
    if (nextSignature === lastSignatureRef.current) {
      lastSyncedTextRef.current = rawText;
      if (preloadedApiRef.current !== excalidrawAPI) {
        preloadedApiRef.current = excalidrawAPI;
        void preloadExcalidrawSceneFonts(excalidrawAPI, scene.elements);
      }
      return;
    }

    if (excalidrawAPI.getAppState?.()?.isLoading) {
      pendingExternalSyncRef.current = true;
      return;
    }

    pendingExternalSyncRef.current = false;
    preloadedApiRef.current = excalidrawAPI;
    lastSyncedTextRef.current = rawText;
    lastSignatureRef.current = nextSignature;
    syncSceneToImperativeApi(excalidrawAPI, scene);
  }, [excalidrawAPI, rawText, scene]);

  const handleCanvasChange = useCallback(
    (elements: readonly ExcalidrawSceneElement[], appState: AppState, files: BinaryFiles) => {
      if (appState?.isLoading) {
        return;
      }

      if (pendingExternalSyncRef.current) {
        pendingExternalSyncRef.current = false;
        const latestScene = latestSceneRef.current;
        if (latestScene && excalidrawAPI) {
          preloadedApiRef.current = excalidrawAPI;
          lastSyncedTextRef.current = latestRawTextRef.current ?? null;
          lastSignatureRef.current = getExcalidrawPersistenceSignature(
            latestScene.elements,
            latestScene.appState,
            latestScene.files,
          );
          syncSceneToImperativeApi(excalidrawAPI, latestScene);
          return;
        }
      }

      const signature = getExcalidrawPersistenceSignature(elements, appState, files);
      if (signature === lastSignatureRef.current) {
        return;
      }

      lastSignatureRef.current = signature;
      const nextJson = serializeExcalidrawScene(elements, appState, files);
      lastCommittedTextRef.current = nextJson;
      lastSyncedTextRef.current = nextJson;
      setFallback({ path, text: nextJson });
      writeExcalidrawSource(path, nextJson);
    },
    [excalidrawAPI, path],
  );

  const handleResetEmpty = useCallback(() => {
    const empty = createEmptyScene();
    const nextJson = serializeExcalidrawScene(empty);
    lastSignatureRef.current = getExcalidrawPersistenceSignature(empty.elements, empty.appState, empty.files);
    lastCommittedTextRef.current = nextJson;
    lastSyncedTextRef.current = nextJson;
    setFallback({ path, text: nextJson });
    writeExcalidrawSource(path, nextJson);
    if (excalidrawAPI) {
      syncSceneToImperativeApi(excalidrawAPI, empty);
    }
  }, [excalidrawAPI, path]);

  const handleBlur = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        void flushExcalidrawAutoSave(path);
      }
    },
    [path],
  );

  return (
    <div className={styles.root} onBlur={handleBlur}>
      <div className={styles.editor}>{children}</div>
      <div className={styles.canvasPane} data-testid="excalidraw-preview">
        {parsed?.error ? (
          <div className={styles.errorBanner} role="alert">
            <div className={styles.errorTitle}>
              <Icon name="warning" size={16} />
              <strong>
                <T>Invalid Excalidraw JSON</T>
              </strong>
            </div>
            <code className={styles.errorDetail}>{parsed.error}</code>
            <p className={styles.errorHint}>
              <T>Reset to an empty diagram to continue editing.</T>
            </p>
            <button type="button" className={styles.resetBtn} onClick={handleResetEmpty}>
              <T>Reset to Empty Diagram</T>
            </button>
          </div>
        ) : (
          <div className={styles.canvasHost} role="region" aria-label={tx("Excalidraw canvas")}>
            {canvasInit && (
              <ExcalidrawCanvas
                key={path}
                excalidrawAPI={setExcalidrawAPI}
                initialData={canvasInit.data}
                onChange={handleCanvasChange}
                theme={isDark ? THEME.DARK : THEME.LIGHT}
                UIOptions={EXCALIDRAW_UI_OPTIONS}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
