import { afterEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "@/bindings";
import {
  activeProfileId,
  applyProfile,
  applyProfileMixed,
  copyProfileName,
  effectiveProfileId,
  isTypoStyled,
  listProfiles,
  newProfileKey,
  overridesOf,
  profileLabel,
  validateProfileName,
  inspectionProfile,
  producerInspectionId,
  subscribeInspectionProfile,
  validateInspections,
} from "./inspections";
import { useProject } from "./project";

const diag = (code: string | null, severity: Diagnostic["severity"] = "warning", server?: string): Diagnostic => ({
  range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
  severity,
  message: `m ${code}`,
  source: "Ruff",
  code,
  server,
});

describe("inspection profiles", () => {
  afterEach(() => useProject.setState({ project: null, settings: null }));

  it("validates leniently", () => {
    expect(
      validateInspections({
        profile: "project",
        default: { "lsp:ruff": { enabled: false, severity: "loud" }, empty: {}, x: { severity: "typo" } },
        project: 3,
      }),
    ).toEqual({
      profile: "project",
      default: { "lsp:ruff": { enabled: false }, x: { severity: "typo" } },
      project: {},
      ideProfiles: {},
      projectProfiles: {},
    });
    expect(validateInspections(undefined).profile).toBe("default");
    expect(effectiveProfileId(validateInspections({ profile: "project" }), false)).toBe("default");
  });

  it("maps built-in producers to their inspections", () => {
    expect(producerInspectionId("file-references")).toBe("builtin:file-references");
    expect(producerInspectionId("ruff")).toBe("lsp:ruff");
  });

  it("drops disabled inspections and remaps severities", () => {
    const items = [diag("F401"), diag("E501", "error"), diag(null, "info")];
    expect(applyProfile({}, "ruff", items)).toBe(items);
    expect(applyProfile({ "lsp:ruff": { enabled: false } }, "ruff", items)).toEqual([]);
    const out = applyProfile(
      {
        "lsp:ruff": { severity: "error" },
        "lsp:ruff:F401": { severity: "weakWarning" },
        "lsp:ruff:E501": { enabled: false },
      },
      "ruff",
      items,
    );
    expect(out.map((d) => [d.code, d.severity])).toEqual([
      ["F401", "info"],
      [null, "error"],
    ]);
    expect(applyProfile({ "lsp:ruff": { severity: "none" } }, "ruff", [diag("x")])[0]!.severity).toBe("hint");
  });

  it("groups mixed results by reporting server", () => {
    const out = applyProfileMixed({ "lsp:ruff": { enabled: false } }, [
      diag("a", "warning", "ruff"),
      diag("b", "warning", "ty"),
    ]);
    expect(out.map((d) => d.code)).toEqual(["b"]);
  });

  it("follows the project's choice of profile and notifies on content changes", () => {
    const calls: number[] = [];
    const off = subscribeInspectionProfile(() => calls.push(1));
    const settings = {
      inspections: { profile: "project", default: { a: { enabled: false } }, project: { b: { enabled: false } } },
    };
    useProject.setState({ settings: settings as never });
    expect(activeProfileId()).toBe("default");
    expect(inspectionProfile()).toEqual({ a: { enabled: false } });
    useProject.setState({ project: { root: "/p" } as never });
    expect(activeProfileId()).toBe("project");
    expect(inspectionProfile()).toEqual({ b: { enabled: false } });
    useProject.setState({ settings: JSON.parse(JSON.stringify(settings)) });
    off();
    expect(calls.length).toBe(2);
  });

  it("gives the Typo inspection its default level and marks typo-level diagnostics", () => {
    const typo = { ...diag(null, "info"), source: "Spelling" };
    const [shown] = applyProfile({}, "spelling", [typo]);
    expect(shown!.severity).toBe("info");
    expect(isTypoStyled(shown!)).toBe(true);
    const [asError] = applyProfile({ "builtin:spelling": { severity: "error" } }, "spelling", [typo]);
    expect(asError!.severity).toBe("error");
    expect(isTypoStyled(asError!)).toBe(false);
    expect(applyProfile({ "builtin:spelling": { enabled: false } }, "spelling", [typo])).toEqual([]);
    // Any inspection can be shown at the Typo level.
    expect(isTypoStyled(applyProfile({ "lsp:ruff": { severity: "typo" } }, "ruff", [diag("x")])[0]!)).toBe(true);
  });

  it("shows PHPStan results as warnings, each identifier turned off or re-graded on its own", () => {
    const phpstan = (code: string | null): Diagnostic => ({ ...diag(code, "warning", "phpstan"), source: "PHPStan" });
    const items = [phpstan("constant.notFound"), phpstan("return.type"), phpstan(null)];
    expect(producerInspectionId("phpstan")).toBe("builtin:phpstan");
    expect(applyProfile({}, "phpstan", items).map((d) => d.severity)).toEqual(["warning", "warning", "warning"]);
    const out = applyProfile(
      {
        "builtin:phpstan:constant.notFound": { enabled: false },
        "builtin:phpstan:return.type": { severity: "error" },
      },
      "phpstan",
      items,
    );
    expect(out.map((d) => [d.code, d.severity])).toEqual([
      ["return.type", "error"],
      [null, "warning"],
    ]);
    expect(applyProfile({ "builtin:phpstan": { enabled: false } }, "phpstan", items)).toEqual([]);
  });

  it("lists, labels and resolves copied profiles", () => {
    const s = validateInspections({
      profile: "ide:strict",
      default: { a: { enabled: false } },
      ideProfiles: { strict: { name: "Strict", overrides: { b: { severity: "error" } } }, bad: 3 },
      projectProfiles: { team: { name: "Team", overrides: {} } },
    });
    expect(s.ideProfiles.bad).toEqual({ name: "bad", overrides: {} });
    expect(listProfiles(s, true).map((p) => [p.id, p.label, p.level])).toEqual([
      ["project", "Project Default", "project"],
      ["project:team", "Team", "project"],
      ["default", "Default", "ide"],
      ["ide:bad", "bad", "ide"],
      ["ide:strict", "Strict", "ide"],
    ]);
    expect(listProfiles(s, false).map((p) => p.id)).toEqual(["default", "ide:bad", "ide:strict"]);
    expect(effectiveProfileId(s, false)).toBe("ide:strict");
    expect(effectiveProfileId({ ...s, profile: "project:team" }, false)).toBe("default");
    expect(effectiveProfileId({ ...s, profile: "ide:gone" }, true)).toBe("default");
    expect(overridesOf(s, "ide:strict")).toEqual({ b: { severity: "error" } });
    expect(profileLabel(s, "project")).toBe("Project Default");
    expect(validateProfileName("Strict", "ide", s)).toMatch(/already exists/);
    expect(validateProfileName("Strict", "project", s)).toBeNull();
    expect(validateProfileName("Strict", "ide", s, "ide:strict")).toBeNull();
    expect(validateProfileName("  ", "ide", s)).toMatch(/empty/);
    expect(copyProfileName("Strict", "ide", s)).toBe("Strict copy");
    expect(newProfileKey("Strict copy!", s.ideProfiles)).toBe("strict-copy");
    expect(newProfileKey("Strict", s.ideProfiles)).toBe("strict-2");
  });
});
