/**
 * The Excalidraw plugin's page: the canvas of the `.excalidraw` file its
 * custom editor shows, kept in step with the file's text (see sync.ts), in
 * the IDE's light or dark theme.
 */
import "./assets";
import { Excalidraw, MainMenu, THEME } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI, UIOptions } from "@excalidraw/excalidraw/types";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { routeDownloadsToTheIde } from "./downloads";
import { applyScene, codec, exportName, loadSceneFonts, type Scene } from "./scene";
import { DocumentSync } from "./sync";

// The canvas is the file's: the IDE opens, saves and themes it, so the page
// keeps only what works on the drawing itself (no Open / Save to, no links
// out of a page without network).
const UI_OPTIONS: UIOptions = {
  canvasActions: {
    changeViewBackgroundColor: true,
    clearCanvas: true,
    export: false,
    loadScene: false,
    saveAsImage: true,
    saveToActiveFile: false,
    toggleTheme: false,
  },
};

function Menu() {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
}

function useIdeTheme(bridge: OpenideaBridge): "dark" | "light" {
  const [dark, setDark] = useState(bridge.theme?.dark ?? window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  useEffect(() => bridge.onThemeChange((t) => setDark(t.dark)), [bridge]);
  return dark ? THEME.DARK : THEME.LIGHT;
}

type Start = { scene: Scene | null; error: string | null; readOnly: boolean; name: string };

function App({ bridge }: { bridge: OpenideaBridge }) {
  const theme = useIdeTheme(bridge);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [start, setStart] = useState<Start | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The document's `source`: the canvas doesn't keep it, the file should.
  const source = useRef<string | undefined>(undefined);
  // `apply` reads the API when the document changes, which is after the canvas exists.
  const sync = useMemo(() => {
    let current: ExcalidrawImperativeAPI | null = null;
    const s = new DocumentSync(bridge.document, codec, {
      apply: (scene) => {
        source.current = scene.source;
        if (current) applyScene(current, scene);
      },
      error: setError,
    });
    return Object.assign(s, { bind: (a: ExcalidrawImperativeAPI | null) => void (current = a) });
  }, [bridge]);

  useEffect(() => {
    sync.start().then(
      (s) => {
        source.current = s.scene?.source;
        setStart(s);
        setError(s.error);
      },
      (e: unknown) =>
        setStart({ scene: null, error: String(e instanceof Error ? e.message : e), readOnly: true, name: "" }),
    );
  }, [sync]);

  useEffect(() => {
    sync.bind(api);
    if (api) void loadSceneFonts(api);
  }, [api, sync]);

  useEffect(() => {
    const onBlur = () => void sync.flush();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [sync]);

  if (!start) return null;
  if (!start.scene && error)
    return (
      <div className="openidea-error">
        <p>This file can't be shown as a drawing until its text is valid again:</p>
        <pre>{error}</pre>
      </div>
    );
  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={start.scene ? { ...start.scene, scrollToContent: true } : null}
      theme={theme}
      viewModeEnabled={start.readOnly}
      name={exportName(start.name)}
      UIOptions={UI_OPTIONS}
      onChange={(elements, appState, files) => sync.changed({ elements, appState, files, source: source.current })}
    >
      <Menu />
    </Excalidraw>
  );
}

const bridge = window.openidea;
const root = createRoot(document.getElementById("root")!);
if (bridge) {
  routeDownloadsToTheIde(bridge);
  root.render(
    <StrictMode>
      <App bridge={bridge} />
    </StrictMode>,
  );
} else {
  root.render(<p className="openidea-error">This page runs inside OpenIDEA.</p>);
}
