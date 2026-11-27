import { afterEach, describe, expect, it, vi } from "vitest";
import type * as TauriCore from "@tauri-apps/api/core";
import type * as Ipc from "@/platform/ipc";
import { render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { IdeEvent, NotebookSnapshot } from "@/bindings";
import { focusedCellEditor } from "@/editor/api";
import { getContext, useContextKeys } from "@/platform/context";
import { CellEditor } from "./CellEditor";
import { NotebookSession, notebookBackend } from "./session";

type KernelEvent = Extract<IdeEvent, { type: "notebookKernel" }>;
const kernelListeners = vi.hoisted(() => new Set<(event: KernelEvent) => void>());
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof Ipc>();
  return {
    ...actual,
    onIdeEvent: (_type: string, listener: (event: KernelEvent) => void) => {
      kernelListeners.add(listener);
      return () => kernelListeners.delete(listener);
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof TauriCore>()),
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
afterEach(() => {
  kernelListeners.clear();
  useContextKeys.setState({}, true);
});

function snapshot(): NotebookSnapshot {
  return {
    id: "document-a",
    path: "/p/a.ipynb",
    version: 1,
    dirty: false,
    nbformat: 4,
    nbformatMinor: 5,
    metadata: {},
    canUndo: false,
    canRedo: false,
    cells: [
      {
        id: "cell-a",
        cellType: "code",
        source: "typed text",
        metadata: {},
        attachments: {},
        executionCount: null,
        outputs: [],
      },
    ],
  };
}

function makeSession(): NotebookSession {
  const document = snapshot();
  const backend: typeof notebookBackend = {
    ...notebookBackend,
    open: async () => structuredClone(document),
    get: async () => structuredClone(document),
    environments: async () => [[], null],
    cellDocs: async () => [],
    close: async () => null,
  };
  return new NotebookSession("/p/a.ipynb", backend, true);
}

describe("cell editor focus", () => {
  it("tracks the focused cell so history can restore its caret", async () => {
    const session = makeSession();
    await session.load();
    const { container, unmount } = render(
      <CellEditor session={session} id="cell-a" source="typed text" type="code" frozen={false} />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
    expect(view).toBeTruthy();
    expect(session.focusedCell).toBeNull();
    view.contentDOM.focus();
    expect(view.hasFocus).toBe(true);
    await vi.waitFor(() => expect(session.focusedCell).toBe("cell-a"));
    view.contentDOM.blur();
    await vi.waitFor(() => expect(session.focusedCell).toBeNull());
    view.contentDOM.focus();
    await vi.waitFor(() => expect(session.focusedCell).toBe("cell-a"));
    unmount();
    expect(session.focusedCell).toBeNull();
    await session.close();
  });
});

describe("cell editor context keys", () => {
  it("publishes the editor keys and the focused view while the cell editor has focus", async () => {
    useContextKeys.setState({}, true);
    const session = makeSession();
    await session.load();
    const { container, unmount } = render(
      <CellEditor session={session} id="cell-a" source="typed text" type="code" frozen={false} />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
    expect(focusedCellEditor()).toBeNull();
    expect(getContext().textEditorActive).toBeFalsy();
    view.contentDOM.focus();
    await vi.waitFor(() => {
      expect(focusedCellEditor()).toBe(view);
      expect(getContext().textEditorActive).toBe(true);
      expect(getContext().editorTextFocus).toBe(true);
    });
    view.contentDOM.blur();
    await vi.waitFor(() => {
      expect(focusedCellEditor()).toBeNull();
      expect(getContext().textEditorActive).toBe(false);
      expect(getContext().editorTextFocus).toBe(false);
    });
    view.contentDOM.focus();
    await vi.waitFor(() => expect(focusedCellEditor()).toBe(view));
    unmount();
    expect(focusedCellEditor()).toBeNull();
    await session.close();
  });
});

describe("cell editor theme", () => {
  const cssRules = () => [...document.styleSheets].reduce((n, sheet) => n + sheet.cssRules.length, 0);

  // Every cell mounting a freshly built theme would add CSS rules and restyle the whole notebook.
  it("adds no CSS rules for each further cell", async () => {
    const session = makeSession();
    await session.load();
    const cell = () => <CellEditor session={session} id="cell-a" source="typed text" type="code" frozen={false} />;
    const first = render(cell());
    const after = cssRules();
    const others = [render(cell()), render(cell())];
    expect(cssRules()).toBe(after);
    [first, ...others].forEach((r) => r.unmount());
    await session.close();
  });
});
