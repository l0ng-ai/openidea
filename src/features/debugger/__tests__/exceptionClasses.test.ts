import { beforeEach, describe, expect, it } from "vitest";
import {
  addExceptionClass,
  loadExceptionClasses,
  parseClassFilters,
  removeAllExceptionClasses,
  removeExceptionClass,
  sanitizeExceptionClasses,
  toExceptionClassBreakpoints,
  updateExceptionClass,
  useExceptionClasses,
} from "../breakpoints/exceptionClasses";

beforeEach(() => {
  localStorage.clear();
  loadExceptionClasses("/p");
  removeAllExceptionClasses();
});

const names = () => useExceptionClasses.getState().list.map((b) => b.className);

describe("exception breakpoints on a chosen class", () => {
  it("are kept per project", () => {
    const bp = addExceptionClass("java.lang.IllegalStateException");
    expect(bp).toMatchObject({ caught: true, uncaught: true, enabled: true, classFiltersEnabled: false });
    updateExceptionClass(bp.id, { caught: false, classFilters: "com.acme.*", classFiltersEnabled: true });
    loadExceptionClasses("/q");
    expect(names()).toEqual([]);
    loadExceptionClasses("/p");
    expect(useExceptionClasses.getState().list).toEqual([
      { ...bp, caught: false, classFilters: "com.acme.*", classFiltersEnabled: true },
    ]);
    removeExceptionClass(bp.id);
    loadExceptionClasses("/p");
    expect(names()).toEqual([]);
  });

  it("splits class filters into included and excluded patterns", () => {
    expect(parseClassFilters(" com.acme.*  -*Test,org.Foo; -com.acme.gen.* ")).toEqual({
      include: ["com.acme.*", "org.Foo"],
      exclude: ["*Test", "com.acme.gen.*"],
    });
    expect(parseClassFilters("- ")).toEqual({ include: [], exclude: [] });
  });

  it("send their filters only when on, muting, and no breakpoint without a class", () => {
    const a = addExceptionClass("com.acme.Boom");
    updateExceptionClass(a.id, { classFilters: "com.acme.* -*Test", classFiltersEnabled: true, uncaught: false });
    const b = addExceptionClass(" java.io.IOException ");
    updateExceptionClass(b.id, { classFilters: "com.acme.*", enabled: false });
    addExceptionClass("  ");
    const { list } = useExceptionClasses.getState();
    expect(toExceptionClassBreakpoints(list, false)).toEqual([
      {
        id: a.id,
        className: "com.acme.Boom",
        caught: true,
        uncaught: false,
        enabled: true,
        classFilters: ["com.acme.*"],
        classExclusionFilters: ["*Test"],
      },
      {
        id: b.id,
        className: "java.io.IOException",
        caught: true,
        uncaught: true,
        enabled: false,
        classFilters: [],
        classExclusionFilters: [],
      },
    ]);
    expect(toExceptionClassBreakpoints(list, true).map((x) => x.enabled)).toEqual([false, false]);
  });

  it("drop sanitized junk", () => {
    expect(
      sanitizeExceptionClasses([
        { className: "a.B", caught: false, classFilters: 3 },
        { caught: true },
        "x",
        { id: "k", className: "c.D", uncaught: false, enabled: false, classFilters: "c.*", classFiltersEnabled: true },
      ]),
    ).toEqual([
      expect.objectContaining({
        className: "a.B",
        caught: false,
        uncaught: true,
        enabled: true,
        classFilters: "",
        classFiltersEnabled: false,
      }),
      {
        id: "k",
        className: "c.D",
        caught: true,
        uncaught: false,
        enabled: false,
        classFilters: "c.*",
        classFiltersEnabled: true,
      },
    ]);
  });
});
