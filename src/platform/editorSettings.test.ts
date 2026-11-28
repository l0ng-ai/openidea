import { expect, it } from "vitest";
import { EDITOR_EXTRA_DEFAULTS, validateEditorExtras } from "./editorSettings";

it("has no encoding mappings unless the settings name some", () => {
  expect(EDITOR_EXTRA_DEFAULTS.encodings.mappings).toEqual({});
  expect(validateEditorExtras(undefined).encodings.mappings).toEqual({});
  expect(validateEditorExtras({ encodings: { mappings: "gbk" } }).encodings.mappings).toEqual({});
});

it("keeps the encoding mappings that name a label", () => {
  const raw = {
    encodings: { project: "gbk", mappings: { "src/main/java": "iso-8859-15", "src/A.java": 5, lib: null } },
  };
  const { encodings } = validateEditorExtras(raw);
  expect(encodings.mappings).toEqual({ "src/main/java": "iso-8859-15" });
  expect(encodings.project).toBe("gbk");
});

it("defaults to whole-line copy, copied-line selection, and paste above", () => {
  expect(validateEditorExtras(undefined).smartKeys).toMatchObject({
    copyLineWhenNoSelection: true,
    selectCopiedLine: true,
    linePasteMode: "above",
  });
});

it("validates every line clipboard option", () => {
  expect(
    validateEditorExtras({
      smartKeys: { copyLineWhenNoSelection: false, selectCopiedLine: false, linePasteMode: "trim" },
    }).smartKeys,
  ).toMatchObject({ copyLineWhenNoSelection: false, selectCopiedLine: false, linePasteMode: "trim" });
  expect(validateEditorExtras({ smartKeys: { linePasteMode: "caret" } }).smartKeys.linePasteMode).toBe("caret");
  expect(validateEditorExtras({ smartKeys: { linePasteMode: "sideways" } }).smartKeys.linePasteMode).toBe("above");
  expect(
    validateEditorExtras({ smartKeys: { copyLineWhenNoSelection: "no", selectCopiedLine: 0 } }).smartKeys,
  ).toMatchObject({ copyLineWhenNoSelection: true, selectCopiedLine: true });
});
