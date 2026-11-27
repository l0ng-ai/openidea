import { afterEach, expect, test } from "vitest";
import { renameFinished, renameResult, type RenameStep } from "./renameObservation.ts";
import type { Renamed } from "../../src/bindings.ts";

const original = "int order = 1;\nuse(order);";
const answer: Renamed = {
  edit: {
    files: [
      {
        kind: "edit",
        path: "/p/A.java",
        edits: [
          { range: { start: { line: 0, col: 4 }, end: { line: 0, col: 9 } }, new_text: "placedOrder" },
          { range: { start: { line: 1, col: 4 }, end: { line: 1, col: 9 } }, new_text: "placedOrder" },
        ],
      },
    ],
  },
  incomplete: null,
};
const step: RenameStep = {
  scope: 1,
  path: "/p/A.java",
  root: "/p",
  oldName: "order",
  newName: "placedOrder",
  original,
  mode: "applied",
  answer,
};
let text = original;
let state = { path: step.path, word: "order", head: 9, line: 0 };
const w = window as unknown as { __openideaPerf?: unknown };
function fixture() {
  w.__openideaPerf = { editorText: () => text, editorState: () => state };
  document.body.innerHTML = '<div class="cm-content"><div class="cm-line"></div></div>';
}
afterEach(() => {
  document.body.innerHTML = "";
  delete w.__openideaPerf;
  text = original;
  state = { path: step.path, word: "order", head: 9, line: 0 };
});

test("a successful response and typed new name are not an applied rename", () => {
  fixture();
  document.body.insertAdjacentHTML("beforeend", '<span class="cm-lsp-hint">Rename failed</span>');
  text = original.replace("order", "placedOrder");
  expect(renameFinished(step)).toBe(false);
  text = original.replaceAll("order", "placedOrder");
  state = { ...state, word: "placedOrder", head: 14 };
  expect(renameFinished(step)).toBe(false);
  document.querySelector(".cm-lsp-hint")!.remove();
  expect(renameFinished(step)).toBe(true);
  expect(renameFinished({ ...step, answer: null })).toBe(false);
  state = { ...state, path: "/p/other.java" };
  expect(renameFinished(step)).toBe(false);
});

test("preview requires the matching title, files and counts without applying text", () => {
  fixture();
  const preview: RenameStep = { ...step, mode: "preview" };
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div role="dialog"><h2>Rename \'order\' to \'placedOrder\'</h2><ul data-testid="refactor-preview"><li><span title="A.java">A.java</span><span>2 occurrences</span></li></ul></div>',
  );
  expect(renameFinished(preview)).toBe(true);
  expect(renameFinished(step)).toBe(false);
  text = original.replaceAll("order", "placedOrder");
  expect(renameFinished(preview)).toBe(false);
  text = original;
  document.querySelector("[title]")!.setAttribute("title", "other.java");
  expect(renameFinished(preview)).toBe(false);
});

test("incomplete responses retain warning identity instead of claiming local application", () => {
  fixture();
  text = original.replaceAll("order", "placedOrder");
  state = { ...state, word: "placedOrder", head: 14 };
  expect(renameFinished({ ...step, answer: { ...answer, incomplete: "indexing" } })).toBe(false);
  const incomplete: Renamed = { ...answer, incomplete: "indexing" };
  expect(renameResult("/p", incomplete, "placedOrder")).toEqual({
    results: { changes: ["A.java:1", "A.java:2"] },
    degraded: "Rename may be incomplete: indexing",
  });
  text = original;
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div role="dialog"><h2>Rename \'order\' to \'placedOrder\'</h2><div role="note">May be incomplete: the language server is still indexing</div><ul data-testid="refactor-preview"><li><span title="A.java">A.java</span><span>2 occurrences</span></li></ul></div>',
  );
  expect(renameFinished({ ...step, answer: incomplete })).toBe(true);
  expect(renameResult("/p", answer, "placedOrder").degraded).toBeNull();
});

test("an incomplete empty answer reports degradation only with its warning, never a terminal error", () => {
  fixture();
  const incomplete: Renamed = { edit: { files: [] }, incomplete: "indexing" };
  document.body.insertAdjacentHTML("beforeend", '<span class="cm-lsp-hint">Rename failed</span>');
  expect(renameFinished({ ...step, answer: incomplete })).toBe(false);
  document.querySelector(".cm-lsp-hint")!.textContent = "May be incomplete: the language server is still indexing";
  expect(renameFinished({ ...step, answer: incomplete })).toBe(true);
  expect(renameResult("/p", incomplete, "placedOrder").degraded).toBe("Rename may be incomplete: indexing");
  expect(renameFinished({ ...step, answer: { edit: { files: [] }, incomplete: null } })).toBe(false);
});
