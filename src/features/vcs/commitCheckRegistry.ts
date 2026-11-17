/**
 * Before-commit checks, registered through one extension point (IDEA's
 * `CheckinHandler`): each check reports at most one result with a severity. An
 * `error` holds the commit back (Commit Anyway goes on), a `warning` or `info`
 * is shown in the commit panel without stopping it.
 */
import type { ReactNode } from "react";
import type { BranchInfo, FileStatus } from "@/bindings";
import type { CommitSettingsValid, GitSettingsValid } from "@/platform/workflowSettings";

export type CommitCheckSeverity = "error" | "warning" | "info";

/** The result's "Review" / "Show details" link. */
export interface CommitFix {
  label: string;
  run(): void | Promise<void>;
}

export interface CommitCheckResult {
  severity: CommitCheckSeverity;
  /**
   * The problem as the commit panel reads it, usually a string. A check that
   * needs more (the TODO list, the CRLF hint) returns rich content instead.
   */
  text: ReactNode;
  fix?: CommitFix;
}

/**
 * What a check runs on: plain data collected before the commit, not the VCS store.
 * The settings are already normalised, and `diagnostics` reports what the language
 * servers have seen so far.
 */
export interface CommitCheckContext {
  /** Absolute paths of the changes that still exist in the working tree. */
  existing: readonly string[];
  amend: boolean;
  /** The selected repository's root, or "" without one. */
  root: string;
  repo: string | null;
  status: readonly FileStatus[];
  branch: BranchInfo | null;
  settings: { commit: CommitSettingsValid; git: GitSettingsValid };
  /** Errors and warnings seen per file (Analyze code). */
  diagnostics(paths: readonly string[]): { errors: number; warnings: number; files: number };
}

export interface CommitCheck {
  /** Stable id, e.g. `vcs.todo`. */
  id: string;
  /** The problem's title in the commit panel; translated there. */
  title: string;
  /** Checks run in ascending order, then by id; default 0. */
  order?: number;
  /** Nothing to report (or the check is turned off): `null`. */
  run(ctx: CommitCheckContext): Promise<CommitCheckResult | null> | CommitCheckResult | null;
}

/**
 * Active registrations, oldest first. A check id may be registered more than once
 * (each activation of the feature registers the built-in checks): the newest
 * registration is the one that runs, and disposing one leaves the others.
 */
const registrations: Array<{ check: CommitCheck }> = [];

/** Registers a check; the newest registration of an id replaces older ones. Returns the unregister. */
export function registerCommitCheck(check: CommitCheck): () => void {
  const registration = { check };
  registrations.push(registration);
  return () => {
    const i = registrations.indexOf(registration);
    if (i >= 0) registrations.splice(i, 1);
  };
}

/** The registered checks, by `order` then id. */
export function getCommitChecks(): CommitCheck[] {
  const byId = new Map<string, CommitCheck>();
  for (const { check } of registrations) byId.set(check.id, check);
  return [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
