import { afterEach, describe, expect, it } from "vitest";
import { getContext } from "./context";
import { classifyFormFactor, installFormFactor, useFormFactor } from "./formFactor";

describe("classifyFormFactor", () => {
  it("is desktop with a fine pointer, whatever the size", () => {
    expect(classifyFormFactor(false, 390, 844)).toEqual({
      formFactor: "desktop",
      touch: false,
    });
  });

  it("tells a phone from a tablet by the touch window's size", () => {
    expect(classifyFormFactor(true, 390, 844).formFactor).toBe("phone");
    expect(classifyFormFactor(true, 844, 390).formFactor).toBe("phone");
    expect(classifyFormFactor(true, 1180, 820)).toEqual({
      formFactor: "tablet",
      touch: true,
    });
    // iPad Slide Over / narrow split view
    expect(classifyFormFactor(true, 375, 1000).formFactor).toBe("phone");
  });
});

describe("installFormFactor", () => {
  const listeners = new Set<() => void>();
  let coarse = false;
  const win = Object.assign(Object.create(window) as Window, {
    innerWidth: 390,
    innerHeight: 844,
    matchMedia: () => ({
      get matches() {
        return coarse;
      },
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  const root = document.createElement("html");
  afterEach(() => useFormFactor.setState({ formFactor: "desktop", touch: false }, true));

  it("mirrors the form factor on the root, the store and the context keys, and follows pointer changes", () => {
    const uninstall = installFormFactor(win, root);
    expect(root.dataset.formFactor).toBe("desktop");
    expect(root.hasAttribute("data-touch")).toBe(false);

    coarse = true;
    for (const f of listeners) f();
    expect(root.dataset.formFactor).toBe("phone");
    expect(root.hasAttribute("data-touch")).toBe(true);
    expect(useFormFactor.getState()).toEqual({
      formFactor: "phone",
      touch: true,
    });
    expect(getContext()).toMatchObject({ formFactor: "phone", touch: true });

    uninstall();
    expect(listeners.size).toBe(0);
  });
});
