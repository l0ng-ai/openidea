import { afterEach, expect, it, vi } from "vitest";
import { isMacHost } from "./keymap";
import { onNavigationModifier, resetNavigationModifier } from "./navigationModifier";

afterEach(() => {
  resetNavigationModifier();
  vi.restoreAllMocks();
});

it("keeps notifying navigation modifier listeners after one throws", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const second = vi.fn();
  onNavigationModifier(() => {
    throw new Error("boom");
  });
  onNavigationModifier(second);
  window.dispatchEvent(new KeyboardEvent("keydown", isMacHost() ? { metaKey: true } : { ctrlKey: true }));
  expect(second).toHaveBeenCalledWith(true);
  expect(error).toHaveBeenCalledOnce();
});
