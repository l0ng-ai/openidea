import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showHint, showPendingHint } from "./hint";

let view: EditorView;
const hint = () => document.querySelector(".cm-lsp-hint")?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  view = new EditorView({ state: EditorState.create({ doc: "foo()" }), parent: document.body });
});
afterEach(() => {
  view.destroy();
  vi.useRealTimers();
});

describe("pending hints", () => {
  it("does not flash for fast requests", () => {
    const done = showPendingHint(view, "Waiting…");
    vi.advanceTimersByTime(100);
    done();
    vi.advanceTimersByTime(1000);
    expect(hint()).toBeNull();
  });

  it("shows a slow request and removes its hint on completion", () => {
    const done = showPendingHint(view, "Waiting…");
    vi.advanceTimersByTime(250);
    expect(hint()).toBe("Waiting…");
    done();
    expect(hint()).toBeNull();
  });

  it("does not dismiss a newer hint when an old request finishes", () => {
    const done = showPendingHint(view, "Waiting…");
    vi.advanceTimersByTime(250);
    showHint(view, "New error", { tone: "error" });
    done();
    expect(hint()).toBe("New error");
  });

  it("does not overwrite a newer hint while waiting to show progress", () => {
    const done = showPendingHint(view, "Waiting…");
    vi.advanceTimersByTime(100);
    showHint(view, "New error", { tone: "error" });
    vi.advanceTimersByTime(150);
    expect(hint()).toBe("New error");
    done();
    expect(hint()).toBe("New error");
  });

  it.each(["edit", "move", "destroy"])("does not show stale progress after %s", (change) => {
    const done = showPendingHint(view, "Waiting…");
    if (change === "edit") view.dispatch({ changes: { from: 0, insert: "x" } });
    if (change === "move") view.dispatch({ selection: { anchor: 3 } });
    if (change === "destroy") view.destroy();
    vi.advanceTimersByTime(250);
    done();
    expect(hint()).toBeNull();
  });
});
