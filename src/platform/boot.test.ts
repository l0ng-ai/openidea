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

it("handles startup rejections and preserves the first failure", () => {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: { message: "startup rejected" } });
  window.dispatchEvent(event);
  window.dispatchEvent(new ErrorEvent("error", { message: "later failure" }));
  expect(document.querySelector("textarea")?.value).toContain("startup rejected");
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
