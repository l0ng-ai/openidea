import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
const { needsStubs } = await import("./stubs");

it("asks for stubs when Django has none", () => {
  expect(needsStubs(["django", "asgiref"])).toBe(true);
  expect(needsStubs(["django", "django-types"])).toBe(false);
  expect(needsStubs(["django", "django-stubs"])).toBe(false);
  expect(needsStubs(["flask"])).toBe(false);
});
