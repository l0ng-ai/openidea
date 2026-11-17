import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
  vi.resetModules();
  document.body.innerHTML = '<div id="splash" class="splash"></div>';
});
afterEach(() => vi.useRealTimers());

const splash = () => document.getElementById("splash");

it("gives up on a slow launch after its time limit", async () => {
  const { holdSplash, hideSplash } = await import("./splash");
  holdSplash(new Promise(() => {}));
  hideSplash();
  await vi.advanceTimersByTimeAsync(5000);
  expect(splash()).toBeNull();
});

it("stays up, under dialogs, until a question asked while the window opens is answered", async () => {
  const { askOverSplash, holdSplash, hideSplash } = await import("./splash");
  let answer!: (open: boolean) => void;
  const question = new Promise<boolean>((resolve) => (answer = resolve));
  holdSplash(question);
  hideSplash();
  askOverSplash(question);
  expect(splash()?.classList.contains("splash-under-dialogs")).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(splash()).not.toBeNull();
  answer(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(splash()).toBeNull();
});

it("leaves a page without a splash alone", async () => {
  document.body.innerHTML = "";
  const { askOverSplash } = await import("./splash");
  expect(() => askOverSplash(Promise.resolve(true))).not.toThrow();
});
