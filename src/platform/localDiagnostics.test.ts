import { afterEach, expect, it, vi } from "vitest";
import { onLocalDiagnostics, publishLocalDiagnostics } from "./localDiagnostics";

afterEach(() => vi.restoreAllMocks());

it("keeps notifying local diagnostics listeners after one throws", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const second = vi.fn();
  const offs = [
    onLocalDiagnostics(() => {
      throw new Error("boom");
    }),
    onLocalDiagnostics(second),
  ];
  try {
    publishLocalDiagnostics("/p/a.sql", "sql", []);
  } finally {
    offs.forEach((off) => off());
  }
  expect(second).toHaveBeenCalledWith("/p/a.sql", "sql", []);
  expect(error).toHaveBeenCalledOnce();
});
