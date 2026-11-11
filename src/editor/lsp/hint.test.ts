import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PENDING_HINT_DELAY_MS, showHint, showPendingHint } from "./hint";

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
    vi.advanceTimersByTime(PENDING_HINT_DELAY_MS - 10);
    done();
    vi.advanceTimersByTime(1000);
    expect(hint()).toBeNull();
  });

  it("shows a slow request within the feedback budget and removes its hint on completion", () => {
    expect(PENDING_HINT_DELAY_MS).toBeLessThan(100);
    const done = showPendingHint(view, "Waiting…");
    vi.advanceTimersByTime(PENDING_HINT_DELAY_MS);
    expect(hint()).toBe("Waiting…");
    done();
    expect(hint()).toBeNull();
  });

  it("does not dismiss a newer hint when an old request finishes", () => {
    const done = showPendingHint(view, "Waiting…");
    vi.advanceTimersByTime(PENDING_HINT_DELAY_MS);
    showHint(view, "New error", { tone: "error" });
    done();
    expect(hint()).toBe("New error");
  });

  it("does not overwrite a newer hint while waiting to show progress", () => {
    const done = showPendingHint(view, "Waiting…");
    vi.advanceTimersByTime(PENDING_HINT_DELAY_MS - 10);
    showHint(view, "New error", { tone: "error" });
    vi.advanceTimersByTime(20);
    expect(hint()).toBe("New error");
    done();
    expect(hint()).toBe("New error");
  });

  it.each(["edit", "move", "destroy"])("does not show stale progress after %s", (change) => {
    const done = showPendingHint(view, "Waiting…");
    if (change === "edit") view.dispatch({ changes: { from: 0, insert: "x" } });
    if (change === "move") view.dispatch({ selection: { anchor: 3 } });
    if (change === "destroy") view.destroy();
    vi.advanceTimersByTime(PENDING_HINT_DELAY_MS);
    done();
    expect(hint()).toBeNull();
  });
});
