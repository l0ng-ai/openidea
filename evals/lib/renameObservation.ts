import { normalizePath } from "./scenario.ts";
import type { Renamed } from "../../src/bindings.ts";

export interface RenameStep {
  scope: number;
  root: string;
  path: string;
  original: string;
  oldName: string;
  newName: string;
  mode: "preview" | "applied";
  answer: Renamed | null;
}

/** Self-contained: track serializes this check into the measured page. */
export function renameFinished(arg: RenameStep): boolean {
  const answer = arg.answer;
  if (!answer || document.querySelector(".cm-lsp-inplace")) return false;
  type ProbeWindow = {
    __openideaPerf: {
      editorText(): string | null;
      editorState(): { path: string; head: number; word: string } | null;
    };
  };
  const w = window as unknown as ProbeWindow;
  const probe = w.__openideaPerf;
  const state = probe.editorState();
  const text = probe.editorText();
  if (state?.path !== arg.path || text === null) return false;
  if (!answer.edit.files.length) {
    return (
      text === arg.original &&
      !!answer.incomplete &&
      /may be incomplete/i.test(document.querySelector(".cm-lsp-hint:not([data-pending])")?.textContent ?? "")
    );
  }
  if (document.querySelector(".cm-lsp-hint:not([data-pending]):not(.cm-lsp-inplace-hint)")) return false;
  const preview = document.querySelector('[data-testid="refactor-preview"]');
  if (arg.mode === "preview" || answer.incomplete) {
    if (!preview || text !== arg.original) return false;
    const dialog = preview.closest('[role="dialog"]');
    const title = dialog?.querySelector('h1, h2, [data-slot="dialog-title"]')?.textContent ?? dialog?.textContent ?? "";
    if (!title.includes(`'${arg.oldName}'`) || !title.includes(`'${arg.newName}'`)) return false;
    if (answer.incomplete && !dialog?.querySelector('[role="note"]')) return false;
    const entries = new Map<string, { edits: number; operation?: string; to?: string }>();
    for (const file of answer.edit.files) {
      const path = file.kind === "rename" ? file.from : file.path;
      let entry = entries.get(path);
      if (!entry) entries.set(path, (entry = { edits: 0 }));
      if (file.kind === "edit") entry.edits += file.edits.length;
      else {
        entry.operation = file.kind;
        if (file.kind === "rename") entry.to = file.to;
      }
    }
    const expected = [...entries].filter(([, entry]) => entry.edits || entry.operation);
    const rows = [...preview.querySelectorAll("li")];
    return (
      rows.length === expected.length &&
      expected.every(([path, entry]) => {
        const relative = path.startsWith(arg.root + "/") ? path.slice(arg.root.length + 1) : path;
        const row = rows.find((row) =>
          [...row.querySelectorAll("[title]")].some((el) => el.getAttribute("title") === relative),
        );
        if (!row) return false;
        const count = `${entry.edits} ${entry.edits === 1 ? "occurrence" : "occurrences"}`;
        if (entry.edits && ![...row.querySelectorAll("span")].some((el) => el.textContent === count)) return false;
        if (entry.operation === "rename")
          return !!entry.to && !!row.textContent?.includes(`→ ${entry.to.slice(entry.to.lastIndexOf("/") + 1)}`);
        return !entry.operation || !!row.textContent?.includes(entry.operation);
      })
    );
  }
  if (preview || answer.preview || answer.edit.files.some((file) => file.kind !== "edit" || file.path !== arg.path))
    return false;
  const edits = answer.edit.files.flatMap((file) => (file.kind === "edit" ? file.edits : []));
  if (!edits.length) return false;
  const lines = arg.original.split("\n");
  const offset = (pos: { line: number; col: number }) => {
    if (pos.line < 0 || pos.line >= lines.length || pos.col < 0 || pos.col > lines[pos.line]!.length) return -1;
    let at = pos.col;
    for (let i = 0; i < pos.line; i++) at += lines[i]!.length + 1;
    return at;
  };
  const changes = edits
    .map((edit) => ({ from: offset(edit.range.start), to: offset(edit.range.end), text: edit.new_text }))
    .sort((a, b) => b.from - a.from);
  let expected = arg.original;
  let previous = expected.length;
  for (const change of changes) {
    if (change.from < 0 || change.to < change.from || change.to > previous) return false;
    expected = expected.slice(0, change.from) + change.text + expected.slice(change.to);
    previous = change.from;
  }
  // Exact edit application excludes the temporary, optimistically typed in-place name.
  return (
    expected !== arg.original &&
    text === expected &&
    state.word === arg.newName &&
    state.head >= 0 &&
    state.head <= text.length
  );
}

export function renameResult(root: string, answer: Renamed, newName: string) {
  const changes = answer.edit.files.flatMap((file) =>
    file.kind === "edit"
      ? file.edits.flatMap((edit) =>
          edit.new_text
            .split("\n")
            .flatMap((line, i) =>
              line.includes(newName) ? [`${normalizePath(root, file.path)}:${edit.range.start.line + i + 1}`] : [],
            ),
        )
      : [],
  );
  return {
    results: { changes },
    degraded: answer.incomplete ? `Rename may be incomplete: ${answer.incomplete}` : null,
  };
}
