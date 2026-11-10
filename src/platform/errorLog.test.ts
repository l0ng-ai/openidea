import { afterEach, describe, expect, it, vi } from "vitest";

const logFrontend = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "project-2" }) }));
vi.mock("./ipc", () => ({ isTauri: () => true, commands: { logFrontend } }));

import { describeError, installErrorLogging } from "./errorLog";

afterEach(() => logFrontend.mockClear());

describe("frontend errors in the log", () => {
  it("writes uncaught errors and unhandled rejections once each, with the window", () => {
    const off = installErrorLogging();
    const boom = new Error("boom");
    window.dispatchEvent(new ErrorEvent("error", { error: boom, message: "boom" }));
    window.dispatchEvent(new ErrorEvent("error", { error: boom, message: "boom" }));
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.assign(rejection, { reason: "no project" });
    window.dispatchEvent(rejection);
    off();
    const late = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.assign(late, { reason: "after" });
    window.dispatchEvent(late);
    expect(logFrontend.mock.calls.map((c) => c as unknown[])).toEqual([
      ["error", expect.stringMatching(/^\[project-2\] uncaught error: Error: boom\n\s+at /)],
      ["error", "[project-2] unhandled rejection: no project"],
    ]);
  });

  it("describes errors, strings and other values", () => {
    expect(describeError("x")).toBe("x");
    expect(describeError({ kind: "notFound" })).toBe('{"kind":"notFound"}');
    expect(describeError(undefined)).toBe("undefined");
  });
});
