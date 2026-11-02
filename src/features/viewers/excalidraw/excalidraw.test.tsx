import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, editorContributions, type EditorDocContext } from "@/editor/api";
import { ExcalidrawEditor } from "./ExcalidrawEditor";
import { registerExcalidrawLiveSource, useLiveExcalidraw, writeExcalidrawSource } from "./live";
import { modeOf, setExcalidrawMode, useExcalidrawModes } from "./modes";
import {
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
} from "./scene";

const ctx: EditorDocContext = {
  doc: 1,
  path: "/p/architecture.excalidraw",
  language: "json",
  uiMode: null,
  readOnly: false,
};

describe("Excalidraw scene model and SVG renderer", () => {
  it("parses empty, full, and array-based Excalidraw scenes", () => {
    const empty = parseExcalidrawScene("   ");
    expect(empty.error).toBeNull();
    expect(empty.scene?.elements).toEqual([]);

    const fromArray = parseExcalidrawScene(
      JSON.stringify([{ id: "r1", type: "rectangle", x: 10, y: 20, width: 120, height: 60 }]),
    );
    expect(fromArray.error).toBeNull();
    expect(fromArray.scene?.elements).toHaveLength(1);
    expect(fromArray.scene?.elements[0]?.id).toBe("r1");

    const invalid = parseExcalidrawScene("{ bad json");
    expect(invalid.error).toBeTruthy();
  });

  it("creates elements, computes bounds, hit-tests, updates labels, and renders SVG", () => {
    const rect = createElement("rectangle", 40, 50, 160, 80, {
      id: "box-1",
      label: { text: "Core Service" },
      fillStyle: "hachure",
      backgroundColor: "#a5d8ff",
    });
    const diamond = createElement("diamond", 240, 50, 120, 80, {
      id: "decision-1",
      fillStyle: "cross-hatch",
      backgroundColor: "#ffec99",
    });
    const ellipse = createElement("ellipse", 400, 50, 100, 80, {
      id: "db-1",
      fillStyle: "solid",
      backgroundColor: "#b2f2bb",
    });
    const arrow = createElement("arrow", 200, 90, 40, 0, {
      id: "arr-1",
      endArrowhead: "arrow",
    });
    const freedraw = createElement("freedraw", 20, 160, 60, 20, {
      id: "free-1",
      points: [
        [0, 0],
        [30, 15],
        [60, 5],
      ],
    });
    const scene = {
      ...createEmptyScene(),
      elements: [rect, diamond, ellipse, arrow, freedraw],
    };

    expect(getElementBounds(rect)).toEqual({
      minX: 40,
      minY: 50,
      maxX: 200,
      maxY: 130,
      width: 160,
      height: 80,
      cx: 120,
      cy: 90,
    });
    expect(getSceneBounds(scene.elements).width).toBeGreaterThan(400);
    expect(hitTestElement(scene.elements, 100, 80)?.id).toBe("box-1");
    expect(hitTestElement(scene.elements, 999, 999)).toBeNull();

    const relabeled = setElementLabel(scene, "box-1", "Updated Gateway");
    const updatedBox = relabeled.elements.find((el) => el.id === "box-1")!;
    expect(getElementLabel(updatedBox, relabeled.elements)).toBe("Updated Gateway");

    const svgLight = renderExcalidrawSvg(relabeled, { dark: false });
    expect(svgLight).toContain("<svg");
    expect(svgLight).toContain("Updated Gateway");
    expect(svgLight).toContain("<polygon");
    expect(svgLight).toContain("<ellipse");

    const svgDark = renderExcalidrawSvg(relabeled, { dark: true });
    expect(svgDark).toContain("<svg");

    const roundTrip = parseExcalidrawScene(serializeExcalidrawScene(relabeled));
    expect(roundTrip.error).toBeNull();
    expect(roundTrip.scene?.elements).toHaveLength(6);
  });
});

describe("Excalidraw editor and live CodeMirror synchronization", () => {
  const disposers: Array<() => void> = [];
  const views: EditorView[] = [];

  beforeEach(() => {
    disposers.push(registerExcalidrawLiveSource());
  });

  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    useLiveExcalidraw.setState({}, true);
    useExcalidrawModes.setState({ byPath: {}, fallback: "preview" }, true);
  });

  it("syncs CodeMirror buffer changes with the interactive Excalidraw canvas", () => {
    const initialScene = {
      ...createEmptyScene(),
      elements: [createElement("rectangle", 20, 20, 140, 70, { id: "rect-1", label: { text: "Auth API" } })],
    };
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

    expect(modeOf(useExcalidrawModes.getState(), ctx.path)).toBe("preview");

    render(
      <ExcalidrawEditor path={ctx.path} tabId="tab-1">
        <div data-testid="cm-child" />
      </ExcalidrawEditor>,
    );

    const canvas = screen.getByRole("region", { name: "Excalidraw canvas" });
    expect(canvas.textContent).toContain("Auth API");

    // Clear canvas button updates the underlying CodeMirror document live.
    fireEvent.click(screen.getByTitle("Clear canvas"));
    expect(JSON.parse(view.state.doc.toString()).elements).toEqual([]);

    // External writeExcalidrawSource also updates the CodeMirror document.
    const nextScene = {
      ...createEmptyScene(),
      elements: [createElement("ellipse", 30, 40, 100, 60, { id: "el-2", label: { text: "Cache" } })],
    };
    act(() => {
      writeExcalidrawSource(ctx.path, serializeExcalidrawScene(nextScene));
    });
    expect(view.state.doc.toString()).toContain("Cache");
    expect(canvas.textContent).toContain("Cache");

    // Switching layout mode to editor hides the canvas pane.
    act(() => {
      setExcalidrawMode(ctx.path, "editor");
    });
    expect(screen.queryByRole("region", { name: "Excalidraw canvas" })).toBeNull();
  });
});
