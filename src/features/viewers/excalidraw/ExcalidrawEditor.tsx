/** Excalidraw editor wrapper: interactive whiteboard canvas + JSON split/editor modes. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { FloatingToolbar, Icon, T } from "@/ui";
import { ExcalidrawLayoutActions } from "./ExcalidrawLayoutActions";
import { getExcalidrawSource, useLiveExcalidraw, writeExcalidrawSource } from "./live";
import { modeOf, useExcalidrawModes } from "./modes";
import {
  EXCALIDRAW_BG_COLORS,
  EXCALIDRAW_STROKE_COLORS,
  createElement,
  createEmptyScene,
  getElementBounds,
  getElementLabel,
  getSceneBounds,
  hitTestElement,
  parseExcalidrawScene,
  renderExcalidrawSvg,
  serializeExcalidrawScene,
  setElementLabel,
  visibleElements,
  type ExcalidrawDocument,
  type ExcalidrawPoint,
  type ExcalidrawTool,
} from "./scene";
import styles from "./Excalidraw.module.css";

interface Props {
  path: string;
  tabId: string;
  actionsInTabs?: boolean;
  children: ReactNode;
}

const TOOLS: readonly { id: ExcalidrawTool; label: string; glyph: string }[] = [
  { id: "selection", label: "Select", glyph: "↖" },
  { id: "hand", label: "Pan canvas", glyph: "✥" },
  { id: "rectangle", label: "Rectangle", glyph: "▭" },
  { id: "diamond", label: "Diamond", glyph: "◇" },
  { id: "ellipse", label: "Ellipse", glyph: "◯" },
  { id: "arrow", label: "Arrow", glyph: "→" },
  { id: "line", label: "Line", glyph: "╱" },
  { id: "freedraw", label: "Freedraw", glyph: "✎" },
  { id: "text", label: "Text", glyph: "T" },
];

type DragInteraction =
  | {
      kind: "pan";
      startClientX: number;
      startClientY: number;
      originPanX: number;
      originPanY: number;
    }
  | {
      kind: "move";
      elementId: string;
      startSceneX: number;
      startSceneY: number;
      originX: number;
      originY: number;
    }
  | {
      kind: "draw";
      tool: Exclude<ExcalidrawTool, "selection" | "hand">;
      startSceneX: number;
      startSceneY: number;
      currentSceneX: number;
      currentSceneY: number;
      points: ExcalidrawPoint[];
    };

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

export function ExcalidrawEditor({ path, tabId, actionsInTabs = false, children }: Props) {
  const mode = useExcalidrawModes((s) => modeOf(s, path));
  const rootRef = useRef<HTMLDivElement>(null);
  const isDark = useSyncExternalStore(subscribeThemeMode, readIsDarkTheme, () => true);

  const liveText = useLiveExcalidraw((s) => s[path]?.text);
  const [fallbackText, setFallbackText] = useState<string>("");
  const rawText = liveText ?? fallbackText;
  const [tool, setTool] = useState<ExcalidrawTool>("selection");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [strokeColor, setStrokeColor] = useState<string>(EXCALIDRAW_STROKE_COLORS[0]);
  const [backgroundColor, setBackgroundColor] = useState<string>(EXCALIDRAW_BG_COLORS[0]);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [drag, setDrag] = useState<DragInteraction | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (getExcalidrawSource(path) === undefined) {
      call(commands.fsReadText(path))
        .then((content) => {
          if (!cancelled && getExcalidrawSource(path) === undefined) {
            setFallbackText(content);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [path]);

  const parsed = useMemo(() => parseExcalidrawScene(rawText), [rawText]);
  const scene = parsed.scene;

  const commitScene = useCallback(
    (next: ExcalidrawDocument) => {
      const nextJson = serializeExcalidrawScene(next);
      setFallbackText(nextJson);
      writeExcalidrawSource(path, nextJson);
    },
    [path],
  );

  const activeElements = useMemo(() => (scene ? visibleElements(scene.elements) : []), [scene]);
  const selectedElement = useMemo(
    () => activeElements.find((el) => el.id === selectedId) ?? null,
    [activeElements, selectedId],
  );

  const selectedLabel = useMemo(
    () => (selectedElement && scene ? getElementLabel(selectedElement, scene.elements) : ""),
    [selectedElement, scene],
  );

  const displayScene = useMemo<ExcalidrawDocument | null>(() => {
    if (!scene) return null;
    if (!drag || drag.kind !== "draw") return scene;
    const dx = drag.currentSceneX - drag.startSceneX;
    const dy = drag.currentSceneY - drag.startSceneY;
    const draft =
      drag.tool === "freedraw"
        ? {
            ...createElement("freedraw", drag.startSceneX, drag.startSceneY, dx, dy, {
              strokeColor,
              backgroundColor,
            }),
            points:
              drag.points.length >= 2
                ? drag.points
                : ([
                    [0, 0],
                    [dx, dy],
                  ] as ExcalidrawPoint[]),
          }
        : createElement(drag.tool, drag.startSceneX, drag.startSceneY, dx, dy, {
            strokeColor,
            backgroundColor,
          });
    return {
      ...scene,
      elements: [...scene.elements, draft],
    };
  }, [scene, drag, strokeColor, backgroundColor]);

  const sceneBounds = useMemo(() => getSceneBounds(displayScene?.elements ?? []), [displayScene]);

  const svgPadding = 48;
  const viewMinX = Math.floor(sceneBounds.minX - svgPadding);
  const viewMinY = Math.floor(sceneBounds.minY - svgPadding);

  const svgMarkup = useMemo(() => {
    if (!displayScene) return "";
    return renderExcalidrawSvg(displayScene, {
      dark: isDark,
      padding: svgPadding,
      background: false,
    });
  }, [displayScene, isDark]);

  const clientToScene = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const el = viewportRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      const offsetX = clientX - rect.left - rect.width / 2 - pan.x;
      const offsetY = clientY - rect.top - rect.height / 2 - pan.y;
      return {
        x: Math.round(sceneBounds.cx + offsetX / zoom),
        y: Math.round(sceneBounds.cy + offsetY / zoom),
      };
    },
    [pan.x, pan.y, sceneBounds.cx, sceneBounds.cy, zoom],
  );

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!scene || e.button !== 0) return;
    const pt = clientToScene(e.clientX, e.clientY);

    if (tool === "hand") {
      setDrag({
        kind: "pan",
        startClientX: e.clientX,
        startClientY: e.clientY,
        originPanX: pan.x,
        originPanY: pan.y,
      });
      return;
    }

    if (tool === "selection") {
      const hit = hitTestElement(scene.elements, pt.x, pt.y);
      if (hit) {
        setSelectedId(hit.id);
        setStrokeColor(hit.strokeColor ?? EXCALIDRAW_STROKE_COLORS[0]);
        setBackgroundColor(hit.backgroundColor ?? EXCALIDRAW_BG_COLORS[0]);
        setDrag({
          kind: "move",
          elementId: hit.id,
          startSceneX: pt.x,
          startSceneY: pt.y,
          originX: hit.x,
          originY: hit.y,
        });
      } else {
        setSelectedId(null);
        setDrag({
          kind: "pan",
          startClientX: e.clientX,
          startClientY: e.clientY,
          originPanX: pan.x,
          originPanY: pan.y,
        });
      }
      return;
    }

    if (tool === "text") {
      const created = createElement("text", pt.x, pt.y, 80, 28, { strokeColor, backgroundColor });
      commitScene({
        ...scene,
        elements: [...scene.elements, created],
      });
      setSelectedId(created.id);
      setTool("selection");
      return;
    }

    setDrag({
      kind: "draw",
      tool,
      startSceneX: pt.x,
      startSceneY: pt.y,
      currentSceneX: pt.x,
      currentSceneY: pt.y,
      points: [[0, 0]],
    });
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || !scene) return;
    if (drag.kind === "pan") {
      setPan({
        x: drag.originPanX + (e.clientX - drag.startClientX),
        y: drag.originPanY + (e.clientY - drag.startClientY),
      });
      return;
    }

    const pt = clientToScene(e.clientX, e.clientY);
    if (drag.kind === "move") {
      const dx = pt.x - drag.startSceneX;
      const dy = pt.y - drag.startSceneY;
      const target = scene.elements.find((el) => el.id === drag.elementId);
      if (!target) return;
      const deltaX = drag.originX + dx - target.x;
      const deltaY = drag.originY + dy - target.y;
      if (deltaX === 0 && deltaY === 0) return;
      commitScene({
        ...scene,
        elements: scene.elements.map((el) => {
          if (el.id === drag.elementId) {
            return { ...el, x: drag.originX + dx, y: drag.originY + dy };
          }
          if (el.type === "text" && el.containerId === drag.elementId) {
            return { ...el, x: el.x + deltaX, y: el.y + deltaY };
          }
          return el;
        }),
      });
      return;
    }

    if (drag.kind === "draw") {
      const relX = pt.x - drag.startSceneX;
      const relY = pt.y - drag.startSceneY;
      setDrag({
        ...drag,
        currentSceneX: pt.x,
        currentSceneY: pt.y,
        points: drag.tool === "freedraw" ? [...drag.points, [relX, relY]] : drag.points,
      });
    }
  };

  const handlePointerUp = () => {
    if (!drag || !scene) return;
    if (drag.kind === "draw") {
      const dx = drag.currentSceneX - drag.startSceneX;
      const dy = drag.currentSceneY - drag.startSceneY;
      const created =
        drag.tool === "freedraw"
          ? {
              ...createElement("freedraw", drag.startSceneX, drag.startSceneY, dx, dy, {
                strokeColor,
                backgroundColor,
              }),
              points:
                drag.points.length >= 2
                  ? drag.points
                  : ([
                      [0, 0],
                      [120, 0],
                    ] as ExcalidrawPoint[]),
            }
          : createElement(drag.tool, drag.startSceneX, drag.startSceneY, dx, dy, {
              strokeColor,
              backgroundColor,
            });
      commitScene({
        ...scene,
        elements: [...scene.elements, created],
      });
      setSelectedId(created.id);
      setTool("selection");
    }
    setDrag(null);
  };

  const handleDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!scene) return;
    const pt = clientToScene(e.clientX, e.clientY);
    const hit = hitTestElement(scene.elements, pt.x, pt.y);
    if (hit) {
      setSelectedId(hit.id);
      return;
    }
    const created = createElement("rectangle", pt.x - 60, pt.y - 32, 120, 64, {
      strokeColor,
      backgroundColor,
    });
    commitScene({
      ...scene,
      elements: [...scene.elements, created],
    });
    setSelectedId(created.id);
    setTool("selection");
  };

  const handleStrokeColorPick = (color: string) => {
    setStrokeColor(color);
    if (!scene || !selectedId) return;
    commitScene({
      ...scene,
      elements: scene.elements.map((el) =>
        el.id === selectedId || (el.type === "text" && el.containerId === selectedId)
          ? { ...el, strokeColor: color }
          : el,
      ),
    });
  };

  const handleBgColorPick = (color: string) => {
    setBackgroundColor(color);
    if (!scene || !selectedId) return;
    commitScene({
      ...scene,
      elements: scene.elements.map((el) => (el.id === selectedId ? { ...el, backgroundColor: color } : el)),
    });
  };

  const handleDeleteSelected = useCallback(() => {
    if (!scene || !selectedId) return;
    commitScene({
      ...scene,
      elements: scene.elements.filter((el) => el.id !== selectedId && el.containerId !== selectedId),
    });
    setSelectedId(null);
  }, [commitScene, scene, selectedId]);

  const handleDuplicateSelected = useCallback(() => {
    if (!scene || !selectedElement) return;
    const newId = `${selectedElement.type}-${Date.now().toString(36)}`;
    const cloned = {
      ...selectedElement,
      id: newId,
      x: selectedElement.x + 24,
      y: selectedElement.y + 24,
    };
    const nextElements = [...scene.elements, cloned];
    const bound = scene.elements.find(
      (el) => !el.isDeleted && el.type === "text" && el.containerId === selectedElement.id,
    );
    if (bound) {
      const boundId = `text-${Date.now().toString(36)}`;
      nextElements.push({
        ...bound,
        id: boundId,
        x: bound.x + 24,
        y: bound.y + 24,
        containerId: newId,
      });
    }
    commitScene({ ...scene, elements: nextElements });
    setSelectedId(newId);
  }, [commitScene, scene, selectedElement]);

  const handleClearCanvas = () => {
    if (!scene) return;
    commitScene({
      ...scene,
      elements: [],
    });
    setSelectedId(null);
  };

  const handleCopySvg = () => {
    if (!scene) return;
    const svg = renderExcalidrawSvg(scene, { dark: isDark, padding: 24, background: true });
    void navigator.clipboard?.writeText(svg);
  };

  const handleFitView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const selectedBounds = useMemo(() => (selectedElement ? getElementBounds(selectedElement) : null), [selectedElement]);

  const canvasPane = (
    <div className={styles.canvasPane} data-testid="excalidraw-preview">
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Excalidraw tools")}>
        <div className={styles.toolGroup}>
          {TOOLS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.toolBtn} ${tool === item.id ? styles.toolBtnActive : ""}`}
              title={tx(item.label)}
              aria-label={tx(item.label)}
              aria-pressed={tool === item.id}
              onClick={() => setTool(item.id)}
            >
              <span className={styles.toolGlyph}>{item.glyph}</span>
            </button>
          ))}
        </div>

        <span className={styles.sep} />

        <div className={styles.swatchGroup} role="group" aria-label={tx("Stroke color")}>
          {EXCALIDRAW_STROKE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`${styles.swatch} ${strokeColor === color ? styles.swatchActive : ""}`}
              style={{ background: color }}
              title={color}
              aria-label={color}
              onClick={() => handleStrokeColorPick(color)}
            />
          ))}
        </div>

        <span className={styles.sep} />

        <div className={styles.swatchGroup} role="group" aria-label={tx("Fill color")}>
          {EXCALIDRAW_BG_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`${styles.swatch} ${color === "transparent" ? styles.swatchTransparent : ""} ${backgroundColor === color ? styles.swatchActive : ""}`}
              style={color === "transparent" ? undefined : { background: color }}
              title={color}
              aria-label={color}
              onClick={() => handleBgColorPick(color)}
            />
          ))}
        </div>

        {selectedElement && scene && (
          <>
            <span className={styles.sep} />
            <input
              type="text"
              className={styles.labelInput}
              aria-label={tx("Element label")}
              placeholder={tx("Element label")}
              value={selectedLabel}
              onChange={(e) => commitScene(setElementLabel(scene, selectedElement.id, e.target.value))}
            />
            <button
              type="button"
              className={styles.actionBtn}
              title={tx("Duplicate selected")}
              aria-label={tx("Duplicate selected")}
              onClick={handleDuplicateSelected}
            >
              <Icon name="copy" size={14} />
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              title={tx("Delete selected")}
              aria-label={tx("Delete selected")}
              onClick={handleDeleteSelected}
            >
              <Icon name="delete" size={14} />
            </button>
          </>
        )}

        <div className={styles.rightControls}>
          <button
            type="button"
            className={styles.actionBtn}
            title={tx("Zoom out")}
            aria-label={tx("Zoom out")}
            onClick={() => setZoom((z) => Math.max(0.25, +(z / 1.2).toFixed(2)))}
          >
            −
          </button>
          <button
            type="button"
            className={styles.zoomReadout}
            title={tx("Reset zoom")}
            aria-label={tx("Reset zoom")}
            onClick={handleFitView}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            title={tx("Zoom in")}
            aria-label={tx("Zoom in")}
            onClick={() => setZoom((z) => Math.min(4, +(z * 1.2).toFixed(2)))}
          >
            +
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            title={tx("Fit to Screen")}
            aria-label={tx("Fit to Screen")}
            onClick={handleFitView}
          >
            1:1
          </button>
          <button
            type="button"
            className={`${styles.actionBtn} ${showGrid ? styles.toolBtnActive : ""}`}
            title={tx("Toggle grid")}
            aria-label={tx("Toggle grid")}
            aria-pressed={showGrid}
            onClick={() => setShowGrid((g) => !g)}
          >
            #
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            title={tx("Copy SVG")}
            aria-label={tx("Copy SVG")}
            onClick={handleCopySvg}
          >
            SVG
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            title={tx("Clear canvas")}
            aria-label={tx("Clear canvas")}
            onClick={handleClearCanvas}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {parsed.error ? (
        <div className={styles.errorBanner} role="alert">
          <div className={styles.errorTitle}>
            <Icon name="warning" size={16} />
            <strong>
              <T>Invalid Excalidraw JSON</T>
            </strong>
          </div>
          <code className={styles.errorDetail}>{parsed.error}</code>
          <p className={styles.errorHint}>
            <T>Switch to the JSON editor to fix the syntax error, or reset to an empty diagram.</T>
          </p>
          <button type="button" className={styles.resetBtn} onClick={() => commitScene(createEmptyScene())}>
            <T>Reset to Empty Diagram</T>
          </button>
        </div>
      ) : (
        <div
          ref={viewportRef}
          className={`${styles.viewport} ${showGrid ? styles.viewportGrid : ""}`}
          role="region"
          aria-label={tx("Excalidraw canvas")}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onKeyDown={(e) => {
            if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
              e.preventDefault();
              handleDeleteSelected();
            } else if (e.key === "Escape") {
              setSelectedId(null);
              setTool("selection");
            }
          }}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              setZoom((z) => Math.max(0.25, Math.min(4, +(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(2))));
            } else {
              setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
            }
          }}
        >
          <div
            className={styles.stage}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          >
            <div className={styles.svgHost} dangerouslySetInnerHTML={{ __html: svgMarkup }} />
            {selectedBounds && (
              <div
                className={styles.selectionBox}
                data-testid="excalidraw-selection-box"
                style={{
                  left: `${selectedBounds.minX - viewMinX - 4}px`,
                  top: `${selectedBounds.minY - viewMinY - 4}px`,
                  width: `${selectedBounds.width + 8}px`,
                  height: `${selectedBounds.height + 8}px`,
                }}
              />
            )}
          </div>

          {activeElements.length === 0 && (
            <div className={styles.emptyHint}>
              <T>Double-click canvas or select a tool above to add shapes</T>
            </div>
          )}

          <div className={styles.statusPill}>
            <span>{activeElements.length}</span>
            <span>·</span>
            <span>Excalidraw v{scene?.version ?? 2}</span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={clsx(styles.split, styles[`mode-${mode}`])}>
      <div className={styles.editor}>{children}</div>
      {mode !== "editor" && canvasPane}
      {!actionsInTabs && (
        <FloatingToolbar targetRef={rootRef}>
          <ExcalidrawLayoutActions path={path} tabId={tabId} />
        </FloatingToolbar>
      )}
    </div>
  );
}
