import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  contributedNavigation,
  invalidateNavigationProviders,
  registerNavigationProvider,
  type NavigationMatch,
} from "./navigationProviders";

const disposers: (() => void)[] = [];
const views: EditorView[] = [];
afterEach(() => {
  disposers.splice(0).forEach((f) => f());
  views.splice(0).forEach((v) => v.destroy());
});
function view() {
  const v = new EditorView({ state: EditorState.create({ doc: "demo.UserMapper" }) });
  views.push(v);
  return v;
}
const hit: NavigationMatch = {
  from: 0,
  to: 15,
  targets: [{ path: "/src/UserMapper.java", range: { start: { line: 0, col: 0 }, end: { line: 0, col: 10 } } }],
};

describe("navigation providers", () => {
  it("shares pending hover/click requests and whole-name results", async () => {
    let calls = 0;
    let finish!: (value: NavigationMatch) => void;
    disposers.push(
      registerNavigationProvider(() => {
        calls++;
        return new Promise((r) => {
          finish = r;
        });
      }),
    );
    const v = view();
    const hover = contributedNavigation(v, 0);
    const click = contributedNavigation(v, 0);
    finish(hit);
    expect(await hover).toEqual(hit);
    expect(await click).toEqual(hit);
    expect(await contributedNavigation(v, 8)).toEqual(hit);
    expect(calls).toBe(1);
  });
  it("drops results after edits and re-queries the new document", async () => {
    let finish!: (value: NavigationMatch) => void;
    const remove = registerNavigationProvider(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    disposers.push(remove);
    const v = view();
    const request = contributedNavigation(v, 0);
    v.dispatch({ changes: { from: 0, insert: "x" } });
    finish(hit);
    expect(await request).toBeNull();
  });
  it("invalidates misses after background indexing and removes disabled providers", async () => {
    let ready = false;
    let calls = 0;
    const off = registerNavigationProvider(async () => {
      calls++;
      return ready ? hit : null;
    });
    disposers.push(off);
    const v = view();
    expect(await contributedNavigation(v, 0)).toBeNull();
    expect(await contributedNavigation(v, 0)).toBeNull();
    expect(calls).toBe(1);
    ready = true;
    invalidateNavigationProviders();
    expect(await contributedNavigation(v, 0)).toEqual(hit);
    off();
    expect(await contributedNavigation(v, 0)).toBeNull();
  });
  it("drops old results after project/provider invalidation", async () => {
    let finish!: (value: NavigationMatch) => void;
    disposers.push(
      registerNavigationProvider(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      ),
    );
    const request = contributedNavigation(view(), 0);
    invalidateNavigationProviders();
    finish(hit);
    expect(await request).toBeNull();
  });
});
