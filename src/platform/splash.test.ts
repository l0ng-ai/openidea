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
  const events: string[] = [];
  const record = (e: Event) => events.push(e.type);
  window.addEventListener("openidea:boot-question", record);
  window.addEventListener("openidea:boot-answer", record);
  try {
    askOverSplash(question);
    expect(splash()?.classList.contains("splash-under-dialogs")).toBe(true);
    // The startup timeout pauses while the user answers.
    expect(events).toEqual(["openidea:boot-question"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(splash()).not.toBeNull();
    answer(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(splash()).toBeNull();
    expect(events).toEqual(["openidea:boot-question", "openidea:boot-answer"]);
  } finally {
    window.removeEventListener("openidea:boot-question", record);
    window.removeEventListener("openidea:boot-answer", record);
  }
});

it("leaves a page without a splash alone", async () => {
  document.body.innerHTML = "";
  const { askOverSplash } = await import("./splash");
  expect(() => askOverSplash(Promise.resolve(true))).not.toThrow();
});
