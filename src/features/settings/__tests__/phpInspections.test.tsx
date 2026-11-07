import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyProfile, inspectionOption, inspectionOptions } from "@/platform/inspections";
import { PHP_INSPECTIONS, PHP_INSPECTION_GROUPS, phpInspection, phpInspectionId } from "@/platform/phpInspections";
import type { Diagnostic } from "@/bindings";
import { PageContext } from "../components/context";
import { PhpInspectionsPage } from "../languages/PhpInspectionsPage";
import { buildPageTree } from "../model/pages";
import { validateSettings } from "../model/schema";
import { useSettingsDialog } from "../model/staging";
import { buildInspectionTree, setOption } from "../pages/editor/inspectionsModel";
import { LANGUAGE_PAGES } from "../pages/languages";

const savedDialog = useSettingsDialog.getState();
afterEach(() => {
  cleanup();
  useSettingsDialog.setState(savedDialog, true);
});

describe("PHP engine inspections", () => {
  it("lists every engine inspection once, in a known group, the call and type checks with Strict", () => {
    const codes = PHP_INSPECTIONS.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const i of PHP_INSPECTIONS) expect(PHP_INSPECTION_GROUPS).toContain(i.group);
    expect(PHP_INSPECTIONS.filter((i) => i.strict).map((i) => i.code)).toEqual([
      "PhpMethodParametersCountMismatch",
      "PhpUnknownNamedArgument",
      "PhpParams",
      "PhpIncompatibleReturnType",
      "PhpFieldAssignmentTypeMismatch",
    ]);
    expect(phpInspectionId("PhpParams")).toBe("lsp:php:PhpParams");
    expect(phpInspection("lsp:php:PhpParams")?.name).toBe("Argument type mismatch");
  });

  it("stores Strict as an option that is off by default", () => {
    const id = phpInspectionId("PhpParams");
    expect(inspectionOptions(id)?.map((o) => o.key)).toEqual(["strict"]);
    expect(inspectionOptions(phpInspectionId("PhpUndefinedClass"))).toBeUndefined();
    expect(inspectionOption({}, id, "strict")).toBe(false);
    const on = setOption({}, id, "strict", true);
    expect(on).toEqual({ [id]: { options: { strict: true } } });
    expect(inspectionOption(on, id, "strict")).toBe(true);
    expect(setOption(on, id, "strict", false)).toEqual({});
  });

  it("applies the profile to the engine's diagnostics by code", () => {
    const d = (code: string): Diagnostic => ({
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
      severity: "warning",
      message: code,
      source: "php",
      code,
      unnecessary: false,
      deprecated: false,
      server: null,
    });
    const items = [d("PhpUndefinedClass"), d("PhpUnusedAlias")];
    const out = applyProfile(
      { "lsp:php:PhpUndefinedClass": { enabled: false }, "lsp:php:PhpUnusedAlias": { severity: "error" } },
      "php",
      items,
    );
    expect(out.map((x) => [x.code, x.severity])).toEqual([["PhpUnusedAlias", "error"]]);
  });

  it("shows them in Editor › Inspections under PHP › Built-in engine", () => {
    const tree = buildInspectionTree(
      [{ name: "PHP", servers: ["intelephense"] }],
      [{ producer: "php", code: "PhpUndefinedClass", source: "php", sample: "" }],
    );
    const php = tree.find((g) => g.name === "PHP")!;
    expect(php.children.map((n) => n.id)).toEqual(["lsp:intelephense", "lsp:php"]);
    const engine = php.children[1]!;
    expect(engine.name).toBe("Built-in engine");
    expect(engine.children.map((n) => n.id)).toEqual(PHP_INSPECTIONS.map((i) => phpInspectionId(i.code)));
    expect(engine.children[0]!.name).toBe("Undefined class");
    expect(tree.find((g) => g.name === "Other")).toBeUndefined();
  });

  it("registers Settings › PHP › Inspections", () => {
    const tree = buildPageTree(LANGUAGE_PAGES.map((p) => ({ ...p, component: p.component! })));
    const langs = tree.find((n) => n.title === "Languages & Frameworks")!;
    const php = langs.children.find((n) => n.title === "PHP")!;
    expect(php.children.map((n) => n.title)).toEqual(["Inspections"]);
    const page = LANGUAGE_PAGES.find((p) => p.id === "languages.php.inspections")!;
    expect(page.keywords).toContain("Argument type mismatch");
  });
});

describe("Settings › PHP › Inspections page", () => {
  const mount = () => {
    const base = validateSettings({
      inspections: { default: { "lsp:php:PhpUnusedAlias": { severity: "error" } } },
    });
    useSettingsDialog.setState({ base, globalBase: base, staged: {} });
    return render(
      <PageContext.Provider value={{ pageId: "languages.php.inspections", scope: "project" }}>
        <PhpInspectionsPage />
      </PageContext.Provider>,
    );
  };
  const stagedDefault = () => useSettingsDialog.getState().staged["global|inspections.default"]?.value;

  it("groups the inspections and stores changes in the profile in effect", () => {
    mount();
    for (const group of PHP_INSPECTION_GROUPS) expect(screen.getByRole("region", { name: group })).toBeTruthy();
    expect(screen.getByText(/Default \(IDE\)/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Enable Undefined class"));
    expect(stagedDefault()).toEqual({
      "lsp:php:PhpUnusedAlias": { severity: "error" },
      "lsp:php:PhpUndefinedClass": { enabled: false },
    });
    expect(screen.getByLabelText<HTMLInputElement>("Enable Undefined class").checked).toBe(false);

    fireEvent.click(screen.getByLabelText("Strict mode for Argument type mismatch"));
    expect(stagedDefault()).toMatchObject({ "lsp:php:PhpParams": { options: { strict: true } } });

    fireEvent.click(screen.getByLabelText("Enable Undefined class"));
    expect(stagedDefault()).toEqual({
      "lsp:php:PhpUnusedAlias": { severity: "error" },
      "lsp:php:PhpParams": { options: { strict: true } },
    });
  });

  it("only offers Strict on the call and type checks", () => {
    mount();
    expect(screen.queryByLabelText("Strict mode for Undefined class")).toBeNull();
    expect(screen.getAllByText("Strict")).toHaveLength(5);
  });
});
