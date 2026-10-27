import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/bindings";

const settingsSet = vi.fn(async (_scope: string, _key: string, _value: string) => ({
  status: "ok" as const,
  data: {} as Settings,
}));
const executeAction = vi.fn(async () => true);
vi.mock("./ipc", async (orig) => {
  const actual = await orig<typeof import("./ipc")>();
  return { ...actual, commands: { ...actual.commands, settingsSet } };
});
vi.mock("./actions", async (orig) => ({ ...(await orig<typeof import("./actions")>()), executeAction }));

const { disableInspection, intentionControls, patchOverride, problemControls, setInspectionOption, setInspectionSeverity } =
  await import("./inspectionControls");
const { diagnosticInspection, inspectionOption, SPELLING_INSPECTION } = await import("./inspections");
const { useProject } = await import("./project");

afterEach(() => {
  useProject.setState({ project: null, settings: null });
  vi.clearAllMocks();
});

const written = () => {
  const [scope, key, value] = settingsSet.mock.calls.at(-1)!;
  return { scope, key, value: JSON.parse(value) };
};

describe("inspection controls", () => {
  it("names the inspection a diagnostic belongs to", () => {
    expect(diagnosticInspection("spelling", { code: null })).toEqual({ id: SPELLING_INSPECTION, name: "Typo" });
    expect(diagnosticInspection("ruff", { code: "F401" })).toEqual({ id: "lsp:ruff:F401", name: "ruff F401" });
    expect(diagnosticInspection("pyright", { code: null })).toEqual({ id: "lsp:pyright", name: "pyright" });
    expect(diagnosticInspection("", { code: null })).toBeNull();
  });

  it("writes to the profile in effect, at its level", async () => {
    useProject.setState({ project: null, settings: { inspections: { default: { x: { severity: "error" } } } } as never });
    await disableInspection(SPELLING_INSPECTION);
    expect(written()).toEqual({
      scope: "global",
      key: "inspections.default",
      value: { x: { severity: "error" }, [SPELLING_INSPECTION]: { enabled: false } },
    });

    useProject.setState({ project: { root: "/p" } as never, settings: { inspections: { profile: "project" } } as never });
    await setInspectionSeverity("lsp:ruff:F401", "weakWarning");
    expect(written()).toEqual({ scope: "project", key: "inspections.project", value: { "lsp:ruff:F401": { severity: "weakWarning" } } });

    useProject.setState({
      project: { root: "/p" } as never,
      settings: { inspections: { profile: "ide:strict", ideProfiles: { strict: { name: "Strict", overrides: {} } } } } as never,
    });
    await setInspectionOption(SPELLING_INSPECTION, "processCode", false);
    expect(written()).toEqual({
      scope: "global",
      key: "inspections.ideProfiles",
      value: { strict: { name: "Strict", overrides: { [SPELLING_INSPECTION]: { options: { processCode: false } } } } },
    });
  });

  it("drops entries that end up empty", () => {
    expect(patchOverride({ a: { severity: "error" } }, "a", (o) => ({ ...o, severity: undefined }))).toEqual({});
  });

  it("reads options with their defaults", () => {
    expect(inspectionOption({}, SPELLING_INSPECTION, "processCode")).toBe(true);
    expect(inspectionOption({ [SPELLING_INSPECTION]: { options: { processCode: false } } }, SPELLING_INSPECTION, "processCode")).toBe(false);
  });

  it("offers IDEA's menu rows, opening Settings on the inspection", () => {
    const ref = { id: "lsp:ruff:F401", name: "ruff F401" };
    const rows = intentionControls(ref);
    expect(rows.map((r) => ("label" in r ? r.label : "-"))).toEqual(["Edit inspection profile setting", "Disable inspection"]);
    (rows[0] as { run: () => void }).run();
    expect(executeAction).toHaveBeenCalledWith("file.settings", "editor.inspections#lsp:ruff:F401");

    useProject.setState({ settings: { inspections: { default: { "lsp:ruff:F401": { severity: "error" } } } } as never });
    const menu = problemControls(ref);
    expect(menu.map((r) => ("label" in r ? r.label : "-"))).toEqual([
      "Disable Inspection 'ruff F401'",
      "Change Severity",
      "Edit Inspection Profile Setting…",
    ]);
    const severity = menu[1] as { submenu: { label: string; checked?: boolean }[] };
    expect(severity.submenu.filter((s) => s.checked).map((s) => s.label)).toEqual(["Error"]);
  });
});
