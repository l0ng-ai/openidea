import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerToolWindow } from "./contributions";
import { installNarrowWindow, NARROW_WINDOW_QUERY } from "./narrowWindow";
import { isToolWindowVisible, loadToolWindowLayout, resetToolWindowLayout, showToolWindow } from "./toolwindows/store";

const Empty = () => null;

/** A matchMedia whose result a test flips, firing the change listeners. */
function stubMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    set(matches: boolean) {
      query.matches = matches;
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
}

let disposers: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  resetToolWindowLayout();
  disposers = [
    registerToolWindow({ id: "project", title: "Project", icon: "folder", anchor: "left", component: Empty }),
  ];
  loadToolWindowLayout("/work/a");
});

afterEach(() => {
  disposers.forEach((d) => d());
  vi.unstubAllGlobals();
});

describe("installNarrowWindow", () => {
  it("collapses the sides when the window narrows and restores them when it widens", () => {
    const media = stubMedia(false);
    const dispose = installNarrowWindow();
    expect(isToolWindowVisible("project")).toBe(true);
    media.set(true);
    expect(isToolWindowVisible("project")).toBe(false);
    media.set(false);
    expect(isToolWindowVisible("project")).toBe(true);
    dispose();
    expect(media.listeners.size).toBe(0);
  });

  it("collapses at startup in a narrow window and again for the next project", () => {
    stubMedia(true);
    const dispose = installNarrowWindow();
    expect(isToolWindowVisible("project")).toBe(false);
    loadToolWindowLayout("/work/b");
    expect(isToolWindowVisible("project")).toBe(false);
    showToolWindow("project");
    expect(isToolWindowVisible("project")).toBe(true);
    dispose();
  });

  it("collapses again when the same project reopens", () => {
    stubMedia(true);
    const dispose = installNarrowWindow();
    showToolWindow("project");
    loadToolWindowLayout("/work/a");
    expect(isToolWindowVisible("project")).toBe(false);
    dispose();
  });

  it("does nothing where matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(() => installNarrowWindow()()).not.toThrow();
    expect(isToolWindowVisible("project")).toBe(true);
  });
});

describe("narrow window breakpoint", () => {
  it("is the one the title bar and welcome page stylesheets use", () => {
    for (const file of ["./TitleBar.module.css", "../features/welcome/Welcome.module.css"]) {
      const css = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(css).toContain(`@media ${NARROW_WINDOW_QUERY}`);
    }
  });
});
