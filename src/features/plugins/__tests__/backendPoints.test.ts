import { afterEach, describe, expect, it, vi } from "vitest";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, syncUiContributions } from "../projection";

describe("backend-only plugin UI points", () => {
  afterEach(() => {
    clearUiContributions();
    vi.restoreAllMocks();
  });

  it("are known to the client, so their items raise no warning", () => {
    const undefine = defineBuiltinUiPoints();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = { id: "p", name: "P", status: "active", enabled: true } as unknown as Parameters<
      typeof syncUiContributions
    >[1][number];
    syncUiContributions(
      ["runConfigurations", "locales", "mcpTools", "serverCommands"].map((point) => ({
        pluginId: "p",
        point,
        key: point,
        decl: {},
      })),
      [plugin],
    );
    expect(warn.mock.calls.filter(([m]) => String(m).includes("no client projection"))).toEqual([]);
    undefine();
  });
});
