/** Builds the selected commit's diff and applies a generated draft without overwriting edits. */
import type { FileStatus, LineHunk } from "@/bindings";
import { tx } from "@/platform/i18n";
import { checkOf, planCommit, renamedFromPath, type CheckState } from "./changes";
import { hunkKeys } from "./hunks";
import { effectiveKind, rootOf, stripSlash } from "./model";

/** Read-only operations needed to compute the exact selected diff. */
export interface CommitDiffIo {
  isBinary(path: string, revision: string | null): Promise<boolean>;
  readRevision(path: string, revision: string): Promise<string | null>;
  readWorking(path: string): Promise<string | null>;
  hunks(oldText: string, newText: string): Promise<LineHunk[]>;
  patch(path: string, oldText: string, newText: string, selected: number[]): Promise<string>;
}

export interface CommitDiffInput {
  status: readonly FileStatus[];
  checks: ReadonlyMap<string, CheckState>;
  excludedHunks: ReadonlyMap<string, ReadonlySet<string>>;
  roots: readonly string[];
  io: CommitDiffIo;
}

/** Returns only the changes the commit panel currently includes, grouped by repository. */
export async function buildCommitDiff({ status, checks, excludedHunks, roots, io }: CommitDiffInput): Promise<string> {
  const files = planCommit(status, checks).included;
  if (!files.length) throw new Error(tx("No changes selected for commit"));
  const sections: string[] = [];
  for (const file of files) {
    const path = stripSlash(file.path);
    const root = rootOf(path, roots);
    if (!root) throw new Error(tx`Cannot locate repository for ${path}`);
    const relative = path.slice(root.length + 1);
    const oldPath = renamedFromPath(file) ?? path;
    const kind = effectiveKind(file);
    if (kind === "conflicted") throw new Error(tx`Resolve conflicts in ${relative} before generating a message`);
    const inclusion = checkOf(file, checks);
    const isAdded = kind === "untracked" || kind === "added";
    const workingDeleted = file.unstaged === "deleted" || (file.staged === "deleted" && file.unstaged === null);
    const selectedDeleted = inclusion === "staged" ? file.staged === "deleted" : workingDeleted;
    const changeKind = isAdded ? "added" : selectedDeleted ? "deleted" : kind === "deleted" ? "modified" : kind;
    const rename = oldPath !== path ? ` (renamed from ${file.renamedFrom})` : "";
    const beforeBinary = !isAdded && (await io.isBinary(oldPath, "HEAD"));
    const afterRevision =
      inclusion === "staged" ? (file.staged === "deleted" ? undefined : ":0") : workingDeleted ? undefined : null;
    const afterBinary = afterRevision !== undefined && (await io.isBinary(path, afterRevision));
    if (beforeBinary || afterBinary) {
      if (inclusion === "hunks") throw new Error(tx`Cannot select individual changes in binary file ${relative}`);
      sections.push(`Repository: ${root}\nFile: ${relative}${rename} (binary ${changeKind})`);
      continue;
    }
    const head = isAdded ? "" : await io.readRevision(oldPath, "HEAD");
    if (head === null) throw new Error(tx`Cannot read the committed version of ${relative}`);
    const before = head;
    let after: string;
    if (inclusion === "staged" && file.staged === "deleted") {
      after = "";
    } else if (inclusion === "staged") {
      const staged = await io.readRevision(path, ":0");
      if (staged === null) throw new Error(tx`Cannot read the staged version of ${relative}`);
      after = staged;
    } else if (workingDeleted) {
      after = "";
    } else {
      const working = await io.readWorking(path);
      if (working === null) throw new Error(tx`Cannot read selected file ${relative}`);
      after = working;
    }
    const hunks = await io.hunks(before, after);
    const keys = hunkKeys(after, hunks);
    const excluded = excludedHunks.get(path) ?? excludedHunks.get(`${path}/`);
    // A stale exclusion cannot safely be mapped to the current contents.
    if (inclusion === "hunks" && (!excluded?.size || [...excluded].some((key) => !keys.includes(key)))) {
      throw new Error(tx`Selected changes in ${relative} changed; review them before generating a message`);
    }
    const selected = hunks.flatMap((_, index) => (inclusion === "hunks" && excluded?.has(keys[index]!) ? [] : [index]));
    if (inclusion === "hunks" && !selected.length) throw new Error(tx`No selected changes remain in ${relative}`);
    const patch = await io.patch(relative, before, after, selected);
    if (!patch && changeKind === "modified") throw new Error(tx`No selected text changes remain in ${relative}`);
    sections.push(`Repository: ${root}\nFile: ${relative}${rename} (${changeKind})\n${patch}`);
  }
  return sections.join("\n\n");
}

/** Limits the context sent to an external provider without splitting Unicode characters. */
export function limitCommitDiff(diff: string): string {
  const chars = Array.from(diff);
  const maxChars = 12_000;
  const truncated = "\n[Diff truncated]";
  return chars.length <= maxChars ? chars.join("") : chars.slice(0, maxChars - truncated.length).join("") + truncated;
}

/** Snapshot used to reject responses after changes to the project, selection or draft. */
export interface CommitGenerationState {
  project: string | null;
  message: string;
  changes: number;
}

export interface CommitGenerationActions {
  getState(): CommitGenerationState;
  setMessage(message: string): void;
  makeDiff(): Promise<string>;
  generate(diff: string): Promise<string>;
}

/** Runs a provider and writes its result only if the invoking state is still current. */
export async function runCommitMessageGeneration(actions: CommitGenerationActions): Promise<"applied" | "changed"> {
  const original = actions.getState();
  const changed = () => {
    const current = actions.getState();
    return (
      original.project !== current.project ||
      original.message !== current.message ||
      original.changes !== current.changes
    );
  };
  const diff = await actions.makeDiff();
  if (changed()) return "changed";
  // Recheck the snapshot before sending it outside the IDE.
  if ((await actions.makeDiff()) !== diff || changed()) return "changed";
  const result = (await actions.generate(diff)).trim();
  if (!result) throw new Error(tx("The commit message generator returned an empty message"));
  if (changed()) return "changed";
  // The file buffers can change without their Git status or inclusion changing.
  if ((await actions.makeDiff()) !== diff || changed()) return "changed";
  actions.setMessage(result);
  return "applied";
}
