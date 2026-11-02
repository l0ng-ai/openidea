import { beforeEach, describe, expect, it } from "vitest";
import type { FileNavigation } from "./model";
import { clearFile, clearProvider, navigationFor, setFileNavigation, useCodeNavigation } from "./store";

const ROUTES = "/p/app/config/routes.rb";
const MODEL = "/p/app/app/models/photo.rb";

const nav = (tag: string): FileNavigation => ({
  links: [{ line: 1, from: 0, to: 3, title: tag, targets: [{ file: `/p/app/${tag}.rb` }] }],
  markers: [{ line: 2, tooltip: tag, targets: [{ table: tag }] }],
});

describe("code navigation store", () => {
  beforeEach(() => useCodeNavigation.setState({ results: {}, files: {} }));

  it("merges the providers' answers per file, in provider order", () => {
    setFileNavigation("code-navigation:rails:1", ROUTES, nav("views"));
    setFileNavigation("code-navigation:rails:0", ROUTES, nav("routes"));
    setFileNavigation("code-navigation:rails:0", MODEL, nav("table"));
    expect(navigationFor(ROUTES)?.links.map((l) => l.title)).toEqual(["routes", "views"]);
    expect(navigationFor(ROUTES)?.markers.map((m) => m.tooltip)).toEqual(["routes", "views"]);
    expect(navigationFor(MODEL)?.markers.map((m) => m.tooltip)).toEqual(["table"]);
    expect(navigationFor("/p/app/other.rb")).toBeNull();
  });

  it("replaces an answer and keeps the other files' objects", () => {
    setFileNavigation("a", ROUTES, nav("one"));
    setFileNavigation("a", MODEL, nav("m"));
    const before = useCodeNavigation.getState().files;
    setFileNavigation("a", ROUTES, nav("two"));
    const after = useCodeNavigation.getState().files;
    expect(after[ROUTES]).not.toBe(before[ROUTES]);
    expect(after[MODEL]).toBe(before[MODEL]);
    expect(navigationFor(ROUTES)?.links[0]?.title).toBe("two");
    // Nothing known any more: the file disappears.
    setFileNavigation("a", ROUTES, null);
    expect(navigationFor(ROUTES)).toBeNull();
    expect(ROUTES in useCodeNavigation.getState().results).toBe(false);
    const unchanged = useCodeNavigation.getState();
    setFileNavigation("b", ROUTES, null);
    expect(useCodeNavigation.getState()).toBe(unchanged);
  });

  it("drops a disposed provider's answers and a closed file", () => {
    setFileNavigation("a", ROUTES, nav("a"));
    setFileNavigation("b", ROUTES, nav("b"));
    setFileNavigation("b", MODEL, nav("b"));
    clearProvider("b");
    expect(navigationFor(ROUTES)?.links.map((l) => l.title)).toEqual(["a"]);
    expect(navigationFor(MODEL)).toBeNull();
    clearFile(ROUTES);
    expect(navigationFor(ROUTES)).toBeNull();
    expect(useCodeNavigation.getState().files).toEqual({});
  });
});
