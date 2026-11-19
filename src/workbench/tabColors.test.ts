import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectColorVars } from "./projectColor";
import { setTabColorOverride, subscribeTabColors, tabColorOverride, tabColorVars } from "./tabColors";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

it("falls back to the name-hashed project colour without an override", () => {
  expect(tabColorVars("databus-plugins", null)).toEqual(projectColorVars("databus-plugins"));
});

it("resolves a preset slot override to that theme slot", () => {
  const vars = tabColorVars("databus-plugins", "4");
  expect(vars["--project-color"]).toContain("--project-color-4");
  expect(vars["--project-color-end"]).toContain("--project-color-4-end");
});

it("resolves a hex override to a flat colour", () => {
  expect(tabColorVars("openidea", "#aabbcc")).toEqual({
    "--project-color": "#aabbcc",
    "--project-color-end": "#aabbcc",
  });
});

it("persists overrides per project root", () => {
  setTabColorOverride("/front", "3");
  setTabColorOverride("/back", "#112233");
  expect(tabColorOverride("/front")).toBe("3");
  expect(tabColorOverride("/back")).toBe("#112233");
  expect(tabColorOverride("/other")).toBeNull();
});

it("clears the override back to the default", () => {
  setTabColorOverride("/front", "3");
  setTabColorOverride("/front", null);
  expect(tabColorOverride("/front")).toBeNull();
});

it("ignores invalid stored values", () => {
  localStorage.setItem("openidea.tabColor.v1:/front", "not-a-colour");
  localStorage.setItem("openidea.tabColor.v1:/back", "10");
  localStorage.setItem("openidea.tabColor.v1:/docs", "#abc");
  expect(tabColorOverride("/front")).toBeNull();
  expect(tabColorOverride("/back")).toBeNull();
  expect(tabColorOverride("/docs")).toBeNull();
});

it("notifies subscribers on a local change", () => {
  const listener = vi.fn();
  const off = subscribeTabColors(listener);
  setTabColorOverride("/front", "5");
  expect(listener).toHaveBeenCalledTimes(1);
  off();
  setTabColorOverride("/front", null);
  expect(listener).toHaveBeenCalledTimes(1);
});

it("notifies subscribers on a cross-window storage event for a tab colour key", () => {
  const listener = vi.fn();
  const off = subscribeTabColors(listener);
  window.dispatchEvent(new StorageEvent("storage", { key: "openidea.tabColor.v1:/front" }));
  expect(listener).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new StorageEvent("storage", { key: "openidea.layout.v1:/front" }));
  expect(listener).toHaveBeenCalledTimes(1);
  off();
});
