import { create } from "zustand";
import type { FileStatus } from "@/bindings";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { checkOf, planCommit, renamedFromPath, type CheckState } from "./changes";
import { useChangelists, withListDefaults } from "./changelists";
import { rememberMessage, useCommit } from "./commitStore";
import { confirmDialog } from "./dialogs";
import { currentHunkText, hunkKeys } from "./hunks";
import { effectiveKind, stripSlash } from "./model";
import { useVcs } from "./store";

const MAX_DIFF_BYTES = 192_000;
const TOO_LARGE = "Selected changes are too large. Select fewer files or blocks.";

interface Generation {
  id: number;
  started: boolean;
}

export const useCommitAi = create<{ generation: Generation | null; error: string | null }>(() => ({
  generation: null,
  error: null,
}));

/** Builds evidence without staging files or including unchecked blocks. */
export async function selectedCommitDiff(
  status: readonly FileStatus[],
  checks: ReadonlyMap<string, CheckState>,
  excludedHunks: ReadonlyMap<string, Set<string>>,
  cancelled: () => boolean,
): Promise<string> {
  const files = planCommit(status, checks).included;
  if (!files.length) throw new Error(tx("No changes selected for commit"));
  const parts: string[] = [];
  let bytes = 0;
  for (const file of files) {
    if (cancelled()) return "";
    if (effectiveKind(file) === "conflicted") throw new Error(tx("Resolve merge conflicts before committing"));
    const path = stripSlash(file.path);
    const check = checkOf(file, checks);
    const kind = check === "staged" ? file.staged : effectiveKind(file);
    const beforePath = renamedFromPath(file) ?? path;
    const before = await call(commands.vcsCommitAiReadText(beforePath, "HEAD"));
    if (cancelled()) return "";
    const after =
      kind === "deleted"
        ? ""
        : check === "staged"
          ? await call(commands.vcsCommitAiReadText(path, ":0"))
          : await call(commands.vcsCommitAiReadText(path, null));
    if (cancelled()) return "";
    const binary = before.includes("\0") || after.includes("\0");
    const hunks = binary ? [] : await commands.vcsDiffHunks(before, after);
    const keys = hunkKeys(after, hunks);
    const excluded = excludedHunks.get(path) ?? excludedHunks.get(`${path}/`);
    const chosen = hunks.filter((_, i) => check !== "hunks" || !excluded?.has(keys[i]!));
    if (!binary && !chosen.length && kind === "modified") continue;
    parts.push(
      JSON.stringify({
        file: file.relPath,
        kind,
        renamedFrom: file.renamedFrom,
        binary,
        changes: chosen.map((h) => ({
          oldStart: h.oldStart,
          newStart: h.start,
          removed: h.oldText,
          added: currentHunkText(after, h),
        })),
      }),
    );
    bytes += new TextEncoder().encode(parts[parts.length - 1]!).length + 1;
    if (bytes > MAX_DIFF_BYTES) throw new Error(tx(TOO_LARGE));
  }
  if (!parts.length) throw new Error(tx("No changes selected for commit"));
  return parts.join("\n");
}

export function cancelCommitMessage() {
  const generation = useCommitAi.getState().generation;
  useCommitAi.setState({ generation: null, error: null });
  if (generation?.started) void commands.cancelRequest(generation.id).catch(() => undefined);
}

export function installCommitAi(): () => void {
  const unsubscribe = useVcs.subscribe((s, before) => {
    if (s.root !== before.root) cancelCommitMessage();
  });
  return () => {
    unsubscribe();
    cancelCommitMessage();
  };
}

export async function generateCommitMessage() {
  if (useCommitAi.getState().generation) return;
  const root = useVcs.getState().root;
  if (!root) return;
  const generation: Generation = { id: nextRequestId(), started: false };
  const active = () => useCommitAi.getState().generation === generation && useVcs.getState().root === root;
  const before = useCommit.getState().message;
  useCommitAi.setState({ generation, error: null });
  try {
    if (
      before.trim() &&
      !(await confirmDialog({
        title: "Replace commit message?",
        message: tx("Replace the current commit message with an AI-generated message?"),
        okLabel: "Generate and Replace",
      }))
    )
      return;
    if (!active()) return;
    const settings = await call(commands.vcsCommitAiSettings());
    if (!settings.config.baseUrl || !settings.config.model) {
      throw new Error(tx("Configure AI in Settings › Version Control › Commit › AI Commit Message."));
    }
    const vcs = useVcs.getState();
    const commit = useCommit.getState();
    const lists = useChangelists.getState().state;
    const checks = withListDefaults(vcs.status, root, lists, commit.checks);
    const diff = await selectedCommitDiff(vcs.status, checks, commit.excludedHunks, () => !active());
    if (!active()) return;
    generation.started = true;
    const message = await call(commands.vcsGenerateCommitMessage(generation.id, diff));
    if (!active()) return;
    if (
      useCommit.getState().checks !== commit.checks ||
      useCommit.getState().excludedHunks !== commit.excludedHunks ||
      useChangelists.getState().state !== lists
    ) {
      throw new Error(tx("Selected changes changed during generation. Generate again for the current selection."));
    }
    if (useCommit.getState().message !== before) {
      throw new Error(
        tx("The commit message changed during generation. Your text was kept; generate again to replace it."),
      );
    }
    rememberMessage(before);
    useCommit.setState((s) => ({ message, focusTick: s.focusTick + 1 }));
  } catch (error) {
    if (active() && !isCancelled(error)) {
      const httpStatus =
        error instanceof Error ? /^AI service returned HTTP (\d{3})$/.exec(error.message)?.[1] : undefined;
      const message = httpStatus
        ? tx`AI service returned HTTP ${httpStatus}`
        : error instanceof Error
          ? tx(error.message)
          : tx("Could not generate commit message");
      useCommitAi.setState({ error: message });
      notifications().notify({
        group: "vcs",
        level: "error",
        title: "Could not generate commit message",
        body: message,
      });
    }
  } finally {
    if (useCommitAi.getState().generation === generation) useCommitAi.setState({ generation: null });
  }
}
