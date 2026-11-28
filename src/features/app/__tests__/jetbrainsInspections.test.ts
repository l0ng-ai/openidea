import { expect, it } from "vitest";
import { parseJetBrainsInspections } from "../jetbrainsInspections";

const strict =
  '<profile version="1.0">' +
  '<option name="myName" value="Strict" />' +
  '<inspection_tool class="PyAbstractClassInspection" enabled="true" level="ERROR" enabled_by_default="true" />' +
  '<inspection_tool class="PyMethodMayBeStaticInspection" enabled="false" level="WEAK WARNING" enabled_by_default="false" />' +
  '<inspection_tool class="PyPep8Inspection" enabled="true" level="WEAK WARNING" enabled_by_default="true">' +
  '<option name="ignoredErrors"><list><option value="E501" /><option value="W5" /></list></option>' +
  "</inspection_tool>" +
  '<inspection_tool class="SpellCheckingInspection" enabled="true" level="INFORMATION" enabled_by_default="true">' +
  '<scope name="Tests" level="TYPO" enabled="false" />' +
  '<option name="processCode" value="false" /><option name="processLiterals" value="true" />' +
  "</inspection_tool>" +
  '<inspection_tool class="PyUnresolvedReferencesInspection" enabled="false" level="WARNING" enabled_by_default="false" />' +
  '<inspection_tool class="PyRedundantOverrideInspection" enabled="true" level="MY_SEVERITY" enabled_by_default="true" />' +
  "</profile>";

it("turns a named profile into an IDE-level copy, and lists what has no counterpart", () => {
  const result = parseJetBrainsInspections({ "inspection/Strict.xml": strict, "inspection/bad.xml": "<oops" }, {});
  expect(result.writes).toEqual([
    [
      "inspections.ideProfiles",
      {
        strict: {
          name: "Strict",
          overrides: {
            "builtin:python-abstract-method": { enabled: true, severity: "error" },
            "builtin:python-method-may-be-static": { enabled: false, severity: "weakWarning" },
            "lsp:ruff:E501": { enabled: false },
            "lsp:pylsp:E501": { enabled: false },
            "builtin:spelling": {
              enabled: true,
              severity: "none",
              options: { processCode: false, processLiterals: true },
            },
            // The custom severity is left out; the inspection still turns on.
            "builtin:python-redundant-override": { enabled: true },
          },
        },
      },
    ],
  ]);
  expect(result.profiles).toEqual([{ name: "Strict", count: 5, id: "ide:strict", replaces: false }]);
  expect(result.unmapped).toEqual([
    "PyPep8Inspection: W5",
    "SpellCheckingInspection (Tests)",
    "PyUnresolvedReferencesInspection",
    "PyRedundantOverrideInspection (MY_SEVERITY)",
  ]);
  expect(result.invalid).toEqual(["bad.xml"]);
});

it("merges Default into the Default profile and replaces an earlier import by name", () => {
  const current = {
    default: { "builtin:sql": { enabled: false }, "builtin:spelling": { enabled: true } },
    ideProfiles: { strict: { name: "Strict", overrides: { "builtin:sql": { enabled: false } } } },
  };
  const def =
    '<profile version="1.0"><option name="myName" value="Default" />' +
    '<inspection_tool class="SpellCheckingInspection" enabled="false" level="TYPO" enabled_by_default="false" /></profile>';
  const result = parseJetBrainsInspections({ "inspection/Default.xml": def, "inspection/Strict.xml": strict }, current);
  expect(result.profiles.map((p) => [p.name, p.replaces])).toEqual([
    ["Default", undefined],
    ["Strict", true],
  ]);
  const writes = Object.fromEntries(result.writes);
  expect(writes["inspections.default"]).toEqual({
    "builtin:sql": { enabled: false },
    "builtin:spelling": { enabled: false, severity: "typo" },
  });
  const customs = writes["inspections.ideProfiles"] as Record<string, { overrides: object }>;
  expect(Object.keys(customs)).toEqual(["strict"]);
  expect(customs.strict!.overrides).not.toHaveProperty("builtin:sql");
});
