import { describe, expect, it } from "vitest";
import { logLineColor } from "./logColors";

const C = {
  enabled: true,
  error: "var(--ansi-red)",
  warn: "var(--ansi-yellow)",
  info: "var(--ansi-green)",
  debug: "var(--ansi-cyan)",
  trace: "var(--ansi-magenta)",
};

describe("logLineColor", () => {
  it("matches the common line formats", () => {
    expect(logLineColor("2026-11-05 10:42:39.123  INFO 4242 --- [nio-8080-exec-1] c.a.S : x", "stdout", C)).toBe(
      "var(--ansi-green)",
    );
    expect(logLineColor("main ERROR com.foo.Bar - log4j line", "stdout", C)).toBe("var(--ansi-red)");
    expect(logLineColor("[ERROR] Failed to execute goal org.apache...", "stdout", C)).toBe("var(--ansi-red)");
    expect(logLineColor("[warn] lowercase marker", "stdout", C)).toBe("var(--ansi-yellow)");
    expect(logLineColor("<Info> log4j2 style", "stdout", C)).toBe("var(--ansi-green)");
    expect(logLineColor('ts=2026-11-05 level=debug msg="hi"', "stdout", C)).toBe("var(--ansi-cyan)");
    expect(logLineColor('{"level":"error","msg":"boom"}', "stdout", C)).toBe("var(--ansi-red)");
    expect(logLineColor('{"severity":"ERROR","message":"gcp"}', "stdout", C)).toBe("var(--ansi-red)");
    expect(logLineColor("SEVERE: javax.servlet - JUL", "stdout", C)).toBe("var(--ansi-red)");
    expect(logLineColor("WARNING: deprecated", "stdout", C)).toBe("var(--ansi-yellow)");
    expect(logLineColor("TRACE detailed", "stdout", C)).toBe("var(--ansi-magenta)");
    expect(logLineColor("FINEST jul fine", "stdout", C)).toBe("var(--ansi-magenta)");
  });

  it("prefers the explicit level field over a later bare word", () => {
    expect(logLineColor('level=debug msg="ERROR fallback"', "stdout", C)).toBe("var(--ansi-cyan)");
  });

  it("stays plain for prose and identifiers", () => {
    expect(logLineColor("information about the error", "stdout", C)).toBeUndefined();
    expect(logLineColor("an error occurred", "stdout", C)).toBeUndefined();
    expect(logLineColor("error-prone checks", "stdout", C)).toBeUndefined();
    expect(logLineColor("ERROR_CODES must not match", "stdout", C)).toBeUndefined();
    expect(logLineColor("GET /api/info 200", "stdout", C)).toBeUndefined();
    expect(logLineColor("my-app.INFO tail", "stdout", C)).toBeUndefined();
    expect(logLineColor("User info panel", "stdout", C)).toBeUndefined();
  });

  it("colours stdout and stderr only, and only when enabled", () => {
    expect(logLineColor("ERROR x", "stderr", C)).toBe("var(--ansi-red)");
    expect(logLineColor("INFO x", "system", C)).toBeUndefined();
    expect(logLineColor("INFO x", "input", C)).toBeUndefined();
    expect(logLineColor("INFO x", "result", C)).toBeUndefined();
    expect(logLineColor("INFO x", "stdout", { ...C, enabled: false })).toBeUndefined();
    expect(logLineColor("plain", "stdout", C)).toBeUndefined();
  });
});
