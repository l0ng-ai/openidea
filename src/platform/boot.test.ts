import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boot = readFileSync("public/boot.js", "utf8");

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div><div id="splash"></div>';
  delete document.documentElement.dataset.boot;
  new Function(boot)();
});
afterEach(() => {
  window.dispatchEvent(new Event("openidea:boot-ready"));
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("surfaces module evaluation errors before React is available", () => {
  window.dispatchEvent(new ErrorEvent("error", { error: new SyntaxError("Invalid regular expression") }));
  expect(document.getElementById("splash")).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("OpenIDEA could not start");
  expect(document.querySelector("textarea")?.value).toContain("Invalid regular expression");
  expect(document.querySelector("textarea")?.value).toContain(navigator.userAgent);
});

const resizeObserverMessages = [
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
];

it.each(resizeObserverMessages)("keeps waiting for boot-ready after %s", (message) => {
  window.dispatchEvent(new ErrorEvent("error", { message, filename: "tauri://localhost" }));
  expect(document.getElementById("splash")).not.toBeNull();
  expect(document.getElementById("boot-error")).toBeNull();
  expect(document.documentElement.dataset.boot).toBeUndefined();
  window.dispatchEvent(new Event("openidea:boot-ready"));
  vi.advanceTimersByTime(30_000);
  expect(document.getElementById("boot-error")).toBeNull();
});

it.each(resizeObserverMessages)("still reports a real failure after %s", (message) => {
  window.dispatchEvent(new ErrorEvent("error", { message }));
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("startup failed") }));
  expect(document.getElementById("splash")).toBeNull();
  expect(document.querySelector("textarea")?.value).toContain("startup failed");
  expect(document.querySelector("textarea")?.value).not.toContain(message);
});

it.each(resizeObserverMessages)("still times out an unresolved startup after %s", (message) => {
  vi.advanceTimersByTime(15_000);
  window.dispatchEvent(new ErrorEvent("error", { message }));
  vi.advanceTimersByTime(15_000);
  expect(document.querySelector("textarea")?.value).toContain("Startup did not finish within 30 seconds.");
});

it.each(resizeObserverMessages)("ignores the loop notification delivered as an Error: %s", (message) => {
  // WebKit (Tauri on Linux) reports the loop with an Error object; Blink as a bare message.
  // No genuine startup failure carries these engine-generated strings.
  window.dispatchEvent(new ErrorEvent("error", { message, filename: "tauri://localhost", error: new Error(message) }));
  expect(document.getElementById("splash")).not.toBeNull();
  expect(document.getElementById("boot-error")).toBeNull();
  expect(document.documentElement.dataset.boot).toBeUndefined();
  window.dispatchEvent(new Event("openidea:boot-ready"));
  vi.advanceTimersByTime(30_000);
  expect(document.getElementById("boot-error")).toBeNull();
});

const reject = (reason: unknown) => {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
};

it("keeps starting after an unhandled rejection", () => {
  reject(new TypeError("Load failed"));
  expect(document.getElementById("splash")).not.toBeNull();
  expect(document.getElementById("boot-error")).toBeNull();
  expect(document.documentElement.dataset.boot).toBeUndefined();
  window.dispatchEvent(new Event("openidea:boot-ready"));
  vi.advanceTimersByTime(30_000);
  expect(document.getElementById("boot-error")).toBeNull();
});

it("reports the first rejection when startup then times out", () => {
  const error = new TypeError("Load failed");
  // WebKit's network TypeErrors have no stack; JSON.stringify turns them into "{}".
  Object.defineProperty(error, "stack", { value: undefined });
  reject(error);
  reject({ message: "later rejection" });
  vi.advanceTimersByTime(30_000);
  const details = document.querySelector("textarea")?.value;
  expect(details).toContain("Startup did not finish within 30 seconds.");
  expect(details).toContain("TypeError: Load failed");
  expect(details).not.toContain("later rejection");
});

it("counts the startup timeout only while the window shows", () => {
  const hidden = (value: boolean) => {
    Object.defineProperty(document, "hidden", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  try {
    vi.advanceTimersByTime(20_000);
    // Behind another window: no frames, so the splash can't finish; that isn't a failure.
    hidden(true);
    vi.advanceTimersByTime(60_000);
    expect(document.getElementById("boot-error")).toBeNull();
    hidden(false);
    vi.advanceTimersByTime(9_000);
    expect(document.getElementById("boot-error")).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector("textarea")?.value).toContain("Startup did not finish within 30 seconds.");
  } finally {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  }
});

it("preserves the first failure", () => {
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("startup failed") }));
  window.dispatchEvent(new ErrorEvent("error", { message: "later failure" }));
  expect(document.querySelector("textarea")?.value).toContain("startup failed");
  expect(document.querySelector("textarea")?.value).not.toContain("later failure");
});

it("handles script load failures but ignores image failures", () => {
  const image = document.createElement("img");
  document.body.append(image);
  image.dispatchEvent(new Event("error"));
  expect(document.getElementById("splash")).not.toBeNull();
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/assets/entry.js";
  document.body.append(script);
  script.dispatchEvent(new Event("error"));
  expect(document.querySelector("textarea")?.value).toContain("/assets/entry.js");
});

it("handles modulepreload load failures", () => {
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = "/assets/dependency.js";
  document.head.append(link);
  try {
    link.dispatchEvent(new Event("error"));
    expect(document.getElementById("splash")).toBeNull();
    expect(document.querySelector("textarea")?.value).toContain("/assets/dependency.js");
  } finally {
    link.remove();
  }
});

it("surfaces initial React render failures through the boot error event", () => {
  window.dispatchEvent(new CustomEvent("openidea:boot-error", { detail: new Error("render failed") }));
  expect(document.querySelector("textarea")?.value).toContain("render failed");
});

it("reports an unresolved startup instead of waiting forever", () => {
  vi.advanceTimersByTime(30_000);
  expect(document.querySelector("textarea")?.value).toContain("Startup did not finish within 30 seconds.");
});

it("stops intercepting failures after a successful startup", () => {
  window.dispatchEvent(new Event("openidea:boot-ready"));
  window.dispatchEvent(new ErrorEvent("error", { message: "runtime failure" }));
  vi.advanceTimersByTime(30_000);
  expect(document.getElementById("boot-error")).toBeNull();
});

it("copies diagnostics and offers manual copying when clipboard access fails", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  window.dispatchEvent(new ErrorEvent("error", { message: "<script>unsafe</script>" }));
  document.querySelector("button")?.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Select"));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("<script>unsafe</script>"));
  expect(document.querySelector("#boot-error script")).toBeNull();
  expect(document.activeElement).toBe(document.querySelector("textarea"));
});

it("uses Chinese boot text without loading the application catalog", () => {
  window.dispatchEvent(new Event("openidea:boot-ready"));
  vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
  new Function(boot)();
  window.dispatchEvent(new ErrorEvent("error", { message: "failure" }));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("OpenIDEA 无法启动");
});

it("confirms a successful copy", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  window.dispatchEvent(new ErrorEvent("error", { message: "startup failed" }));
  document.querySelector("button")?.click();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Copied"));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("startup failed"));
});

it("defers an early script failure until the document body exists", () => {
  const body = document.body;
  body.remove();
  window.dispatchEvent(new ErrorEvent("error", { message: "early failure" }));
  document.documentElement.append(body);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(document.querySelector("textarea")?.value).toContain("early failure");
});

it("preserves Safari error messages when its stack only lists locations", () => {
  const error = new SyntaxError("Unsupported regular expression");
  error.stack = "global code@tauri://localhost/assets/entry.js:1:20";
  window.dispatchEvent(new ErrorEvent("error", { error }));
  expect(document.querySelector("textarea")?.value).toContain("SyntaxError: Unsupported regular expression");
  expect(document.querySelector("textarea")?.value).toContain(error.stack);
});

it("names an outdated system web engine as the cause", () => {
  const supports = vi.fn(() => false);
  vi.stubGlobal("CSS", { supports });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  );
  window.dispatchEvent(new ErrorEvent("error", { error: new SyntaxError("Unexpected token '.'") }));
  const hint = document.querySelector("#boot-error p")?.textContent;
  expect(supports).toHaveBeenCalledWith("container-type", "inline-size");
  expect(hint).toContain("needs Safari 16 or later");
  expect(hint).toContain("Software Update");
  vi.unstubAllGlobals();
});

it("keeps the plain report hint on a current engine", () => {
  vi.stubGlobal("CSS", { supports: () => true });
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("startup failed") }));
  expect(document.querySelector("#boot-error p")?.textContent).toBe(
    "Copy the details below and include them in a GitHub issue.",
  );
  vi.unstubAllGlobals();
});
