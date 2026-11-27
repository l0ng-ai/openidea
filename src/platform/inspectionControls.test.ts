import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/bindings";

const settingsSet = vi.fn(async (_scope: string, key: string, value: string) => ({
  status: "ok" as const,
  // The backend echoes the effective settings; the next update reads them back.
  data: { inspections: { [key.slice("inspections.".length)]: JSON.parse(value) } } as unknown as Settings,
}));
const executeAction = vi.fn(async () => true);
const promptInput = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock("./ipc", async (orig) => {
  const actual = await orig<typeof import("./ipc")>();
  return { ...actual, commands: { ...actual.commands, settingsSet } };
});
vi.mock("./actions", async (orig) => ({ ...(await orig<typeof import("./actions")>()), executeAction }));
// The real input dialog pulls in the workbench UI; the rule row only needs its answer.
vi.mock("@/workbench/inputDialogs", () => ({ promptInput }));

const {
  disableInspection,
  intentionControls,
  patchOverride,
  problemControls,
  setInspectionOption,
  setInspectionSeverity,
} = await import("./inspectionControls");
const { diagnosticInspection, inspectionOption, SPELLING_INSPECTION } = await import("./inspections");
const { useProject } = await import("./project");
type ControlItem = Awaited<ReturnType<(typeof import("./inspectionControls"))["suppressedRuleControls"]>>[number];

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
    // A built-in check reported per code: PHPStan's identifiers.
    expect(diagnosticInspection("phpstan", { code: "constant.notFound" })).toEqual({
      id: "builtin:phpstan:constant.notFound",
      name: "PHPStan constant.notFound",
    });
    expect(diagnosticInspection("phpstan", { code: null })).toEqual({ id: "builtin:phpstan", name: "PHPStan" });
    expect(diagnosticInspection("build", { code: "E0308" })).toEqual({ id: "builtin:build", name: "Build problems" });
    // The Python inheritance checks publish under one producer, each with its inspection id as the code.
    expect(diagnosticInspection("Python", { code: "builtin:python-abstract-method" })).toEqual({
      id: "builtin:python-abstract-method",
      name: "Abstract method not implemented",
    });
  });

  it("writes to the profile in effect, at its level", async () => {
    useProject.setState({
      project: null,
      settings: { inspections: { default: { x: { severity: "error" } } } } as never,
    });
    await disableInspection(SPELLING_INSPECTION);
    expect(written()).toEqual({
      scope: "global",
      key: "inspections.default",
      value: { x: { severity: "error" }, [SPELLING_INSPECTION]: { enabled: false } },
    });

    useProject.setState({
      project: { root: "/p" } as never,
      settings: { inspections: { profile: "project" } } as never,
    });
    await setInspectionSeverity("lsp:ruff:F401", "weakWarning");
    expect(written()).toEqual({
      scope: "project",
      key: "inspections.project",
      value: { "lsp:ruff:F401": { severity: "weakWarning" } },
    });

    useProject.setState({
      project: { root: "/p" } as never,
      settings: {
        inspections: { profile: "ide:strict", ideProfiles: { strict: { name: "Strict", overrides: {} } } },
      } as never,
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
    expect(
      inspectionOption(
        { [SPELLING_INSPECTION]: { options: { processCode: false } } },
        SPELLING_INSPECTION,
        "processCode",
      ),
    ).toBe(false);
  });

  it("offers IDEA's menu rows, opening Settings on the inspection", () => {
    const ref = { id: "lsp:ruff:F401", name: "ruff F401" };
    const rows = intentionControls(ref);
    expect(rows.map((r) => ("label" in r ? r.label : "-"))).toEqual([
      "Edit inspection profile setting",
      "Disable inspection",
      "-",
      "Add rule…",
    ]);
    (rows[0] as { run: () => void }).run();
    expect(executeAction).toHaveBeenCalledWith("file.settings", "editor.inspections#lsp:ruff:F401");

    useProject.setState({
      settings: { inspections: { default: { "lsp:ruff:F401": { severity: "error" } } } } as never,
    });
    const menu = problemControls(ref);
    expect(menu.map((r) => ("label" in r ? r.label : "-"))).toEqual([
      "Disable Inspection 'ruff F401'",
      "Change Severity",
      "Suppressed rules",
      "Edit Inspection Profile Setting…",
    ]);
    const severity = menu[1] as { submenu: { label: string; checked?: boolean }[] };
    expect(severity.submenu.filter((s) => s.checked).map((s) => s.label)).toEqual(["Error"]);
    // No rule of the producer is suppressed yet: only the add row below the separator.
    const rules = menu[2] as { submenu: ControlItem[] };
    expect(rules.submenu.map((r) => ("label" in r ? r.label : "-"))).toEqual(["-", "Add rule…"]);
  });

  it("manages the producer's suppressed rules from the menus", async () => {
    const { codeInspectionId } = await import("./inspections");
    const ref = { id: "lsp:ruff:UP045", name: "ruff UP045" };
    useProject.setState({
      settings: {
        inspections: {
          default: {
            "lsp:ruff:UP045": { enabled: false },
            "lsp:ruff:F401": { enabled: false, severity: "weakWarning" },
            "lsp:pyright:reportU": { enabled: false },
          },
        },
      } as never,
    });
    const checkedLabels = (rows: readonly ControlItem[]) =>
      rows.filter((r) => "label" in r && r.checked).map((r) => ("label" in r ? r.label : ""));
    // The ⌥↵ submenu lists every suppressed code of the same producer, sorted, each checked.
    expect(checkedLabels(intentionControls(ref))).toEqual(["F401", "UP045"]);
    // Problems' Suppressed rules submenu lists the same.
    const rulesRow = problemControls(ref).find((r) => "label" in r && r.label === "Suppressed rules") as {
      submenu: ControlItem[];
    };
    expect(checkedLabels(rulesRow.submenu)).toEqual(["F401", "UP045"]);

    // Unchecking a rule removes the entry (nothing else kept) but leaves the others alone.
    const up045 = rulesRow.submenu.find((r) => "label" in r && r.label === "UP045") as { run: () => void };
    await up045.run();
    expect(written()).toEqual({
      scope: "global",
      key: "inspections.default",
      value: {
        "lsp:ruff:F401": { enabled: false, severity: "weakWarning" },
        "lsp:pyright:reportU": { enabled: false },
      },
    });

    // Add rule… writes a new entry to the profile in effect.
    const add = rulesRow.submenu.find((r) => "label" in r && r.label === "Add rule…") as { run?: () => void };
    promptInput.mockResolvedValueOnce("E501");
    await add.run?.();
    expect(promptInput).toHaveBeenCalled();
    expect(written()).toEqual({
      scope: "global",
      key: "inspections.default",
      value: {
        "lsp:ruff:F401": { enabled: false, severity: "weakWarning" },
        "lsp:ruff:E501": { enabled: false },
        "lsp:pyright:reportU": { enabled: false },
      },
    });
    expect(codeInspectionId("lsp:ruff", "E501")).toBe("lsp:ruff:E501");
  });
});
