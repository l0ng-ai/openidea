import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

const savedStaged: unknown[][] = [];
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsDiffEntries: (entries: unknown[]) => ok(entries.map(() => ({ mode: "100644", gitlink: null }))),
      vcsFileAt: () => ok("one\ntwo\n"),
      vcsFileMode: () => ok("100644"),
      fsProbe: () => ok({ size: 8, binary: false, tooLarge: false }),
      vcsStagedText: () => ok({ text: "one\ntwo\n", version: "v1" }),
      vcsSaveStagedText: (...args: unknown[]) => {
        savedStaged.push(args);
        return ok("v2");
      },
    },
  };
});

// Only the edited file gets a real diff: the others just need to be scrolled past.
vi.mock("../DiffEditor", async (importOriginal) => {
  const real = await importOriginal<typeof import("../DiffEditor")>();
  return {
    ...real,
    ResolvedDiffEditor: (props: Parameters<typeof real.ResolvedDiffEditor>[0]) =>
      props.input.path === "/r/File0.txt" ? <real.ResolvedDiffEditor {...props} /> : <div />,
  };
});

import { _emitEditorEvent, _provideDocumentAttacher } from "@/editor/api";
import { createMemoryBackend } from "@/editor/core/backend";
import { attachDocument } from "@/editor/core/model/attachment";
import { DocumentManager, useDocMeta } from "@/editor/core/model/document";
import { useProject } from "@/platform/project";
import { CombinedDiffTab } from "../CombinedDiff";
import { combinedDiffInput, type DiffData } from "../diffInput";

const paths = Array.from({ length: 20 }, (_, i) => `/r/File${i}.txt`);
const items: DiffData[] = paths.map((path) => ({
  path,
  left: { type: "rev", rev: "HEAD" },
  right: { type: "worktree" },
}));

let manager: DocumentManager;
let backend: ReturnType<typeof createMemoryBackend>;
const offsets = new WeakMap<Element, number>();

beforeEach(() => {
  backend = createMemoryBackend(Object.fromEntries(paths.map((p) => [p, "one\ntwo\n"])));
  manager = new DocumentManager(backend, { settings: () => ({ files: { autoSave: false } }), notify: vi.fn() });
  manager.start();
  _provideDocumentAttacher((p, options) => attachDocument(manager, p, options));
  useProject.setState({ project: { name: "r", root: "/r", trusted: true, isGit: true, settings: {} } as never });
  // jsdom has no layout: every element is 600 px tall (test setup); scrolling is a `scrollTop`.
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return offsets.get(this) ?? 0;
    },
    set(value: number) {
      offsets.set(this, value);
    },
  });
});
afterEach(() => {
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
  for (const model of manager.byPath.values()) {
    model.setMeta({ dirty: false });
    _emitEditorEvent({ type: "docSaved", path: model.path, doc: model.doc });
  }
  manager.stop();
  _provideDocumentAttacher(null);
  useDocMeta.setState({}, true);
});

const block = (path: string) => document.querySelector<HTMLElement>(`[data-combined-block="${path}"]`);
async function editablePane(path: string): Promise<EditorView> {
  return editableSide(path, "b");
}
async function editableSide(path: string, side: "a" | "b"): Promise<EditorView> {
  let view: EditorView | null = null;
  await waitFor(() => {
    const content = block(path)?.querySelector<HTMLElement>(`.cm-merge-${side} .cm-content`);
    expect(content?.textContent).toContain("two");
    view = EditorView.findFromDOM(content!);
    expect(view?.state.readOnly).toBe(false);
  });
  return view!;
}
const scrollTo = (top: number) => {
  const el = document.querySelector<HTMLElement>("[data-combined-scroll]")!;
  for (let at = el.scrollTop; at !== top;) {
    at += Math.sign(top - at) * Math.min(600, Math.abs(top - at));
    act(() => {
      el.scrollTop = at;
      el.dispatchEvent(new Event("scroll"));
    });
  }
};

describe("the all-in-one diff, autosave off", () => {
  it("keeps a block's unsaved edits when it is scrolled away and back", async () => {
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    const view = await editablePane(paths[0]!);
    act(() => view.dispatch({ changes: { from: 0, insert: "EDIT " }, userEvent: "input" }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    const model = manager.byPath.get(paths[0]!)!;
    expect(model.getMeta().dirty).toBe(true);

    scrollTo(15 * 600);
    expect(block(paths[0]!)).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(backend.files.get(paths[0]!)).toBe("one\ntwo\n");

    scrollTo(0);
    const again = await editablePane(paths[0]!);
    expect(again.state.doc.toString()).toBe("EDIT one\ntwo\n");
    expect(manager.byPath.get(paths[0]!)?.getMeta().dirty).toBe(true);
  });
});

describe("the all-in-one diff, staged edits", () => {
  const staged: DiffData[] = items.map((item) => ({ ...item, right: { type: "rev", rev: ":0" } }));
  const editAndScrollAway = async (autoSave: boolean) => {
    savedStaged.length = 0;
    useProject.setState({ settings: { files: { autoSave } } as never });
    render(<CombinedDiffTab input={combinedDiffInput({ items: staged })} />);
    const view = await editableSide(paths[0]!, "b");
    act(() => view.dispatch({ changes: { from: 0, insert: "EDIT " }, userEvent: "input" }));
    scrollTo(15 * 600);
    await act(() => new Promise((r) => setTimeout(r, 20)));
  };

  it("with autosave off, keeps them out of the index while scrolled away", async () => {
    await editAndScrollAway(false);
    expect(savedStaged).toEqual([]);
    expect(block(paths[0]!)).not.toBeNull();
  });

  it("with autosave on, saves them to the index once scrolled away", async () => {
    await editAndScrollAway(true);
    expect(block(paths[0]!)).toBeNull();
    expect(savedStaged.map((args) => args[2])).toEqual(["EDIT one\ntwo\n"]);
  });
});
