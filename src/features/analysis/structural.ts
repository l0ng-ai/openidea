/**
 * Search / Replace Structurally. Search results go to the Find Usages tool
 * window (`find.showUsageResults`); replacements are previewed and applied as
 * one workspace edit.
 */
import { Channel } from "@tauri-apps/api/core";
import { activeEditor, whenAllSynced } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import {
  call,
  commands,
  isTauri,
  nextRequestId,
  type Location,
  type RequestId,
  type StructuralEvent,
  type StructuralFile,
  type StructuralQuery,
  type StructuralSummary,
  type WorkspaceEdit,
} from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { resolveScope, type ScopeChoice } from "./scope";
import { tx } from "@/platform/i18n";

const STATE_KEY = "openidea.analysis.structural.v1";

export interface StructuralForm {
  pattern: string;
  replacement: string;
  language: string;
}

export function loadStructuralForm(): StructuralForm {
  const language = activeEditor()?.ctx.language ?? "";
  try {
    const raw = globalThis.localStorage?.getItem(STATE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<StructuralForm>;
      return {
        pattern: saved.pattern ?? "",
        replacement: saved.replacement ?? "",
        language: language || saved.language || "",
      };
    }
  } catch {
    // storage unavailable
  }
  return { pattern: "", replacement: "", language };
}

export function saveStructuralForm(form: StructuralForm) {
  try {
    globalThis.localStorage?.setItem(STATE_KEY, JSON.stringify(form));
  } catch {
    // storage unavailable
  }
}

/** Key of one match, for including / excluding it in the replace preview. */
export const matchKey = (path: string, i: number) => `${path}\u0000${i}`;

/** Locations of all matches (for the Find Usages view). */
export function matchLocations(files: readonly StructuralFile[]): Location[] {
  return files.flatMap((f) => f.matches.map((m) => ({ path: f.path, range: m.range })));
}

/** One text edit per included match with a replacement. */
export function buildReplaceEdit(files: readonly StructuralFile[], excluded: ReadonlySet<string>): WorkspaceEdit {
  const out: WorkspaceEdit = { files: [] };
  for (const f of files) {
    const edits = f.matches
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => m.replacement != null && !excluded.has(matchKey(f.path, i)))
      .map(({ m }) => ({ range: m.range, new_text: m.replacement! }));
    if (edits.length) out.files.push({ kind: "edit", path: f.path, edits });
  }
  return out;
}

let inflight: RequestId | null = null;

export function cancelStructural() {
  if (inflight !== null) void commands.cancelRequest(inflight).catch(() => undefined);
}

/** Runs the search; resolves with the files with matches, or null when cancelled / failed. */
export async function searchStructurally(
  query: StructuralQuery,
  choice: ScopeChoice,
): Promise<{ files: StructuralFile[]; summary: StructuralSummary } | null> {
  const scope = await resolveScope(choice);
  if (typeof scope === "string") {
    notifications().notify({ group: "analysis", level: "warning", title: "Search Structurally", body: scope });
    return null;
  }
  if (!isTauri()) return null;
  cancelStructural();
  const id = nextRequestId();
  inflight = id;
  const files: StructuralFile[] = [];
  let finish: (s: StructuralSummary | null) => void = () => {};
  const finished = new Promise<StructuralSummary | null>((resolve) => (finish = resolve));
  const channel = new Channel<StructuralEvent>();
  channel.onmessage = (ev) => {
    if (ev.type === "file") files.push(ev.file);
    else finish(ev.summary);
  };
  let done: StructuralSummary | null;
  try {
    await call(commands.structuralSearch(id, scope, query, channel));
    // Channel messages may trail the command's result slightly.
    setTimeout(() => finish(null), 2000);
    done = await finished;
  } catch (e) {
    notifications().notify({
      group: "analysis",
      level: "error",
      title: "Search Structurally",
      body: e instanceof Error ? e.message : String(e),
    });
    return null;
  } finally {
    if (inflight === id) inflight = null;
  }
  if (!done || done.cancelled) return null;
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files, summary: done };
}

/** Shows matches in the Find Usages tool window. */
export async function showStructuralResults(
  pattern: string,
  files: readonly StructuralFile[],
  summary: StructuralSummary,
) {
  if (!files.length) {
    notifications().notify({
      group: "analysis",
      level: "info",
      title: "Search Structurally",
      body: "No occurrences found",
    });
    return;
  }
  const label = pattern.replace(/\s+/g, " ").trim();
  await executeAction("find.showUsageResults", {
    symbol: label.length > 60 ? `${label.slice(0, 59)}…` : label,
    locations: matchLocations(files),
  });
  if (summary.limitHit) {
    notifications().notify({
      group: "analysis",
      level: "warning",
      title: "Search Structurally",
      body: tx`Stopped after ${summary.matches} matches`,
    });
  }
}

export async function applyStructuralReplace(edit: WorkspaceEdit): Promise<void> {
  try {
    await whenAllSynced();
    await call(commands.applyWorkspaceEdit(edit));
  } catch (e) {
    notifications().notify({
      group: "analysis",
      level: "error",
      title: "Replace Structurally",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}
