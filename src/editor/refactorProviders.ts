/**
 * Find Usages and Rename for names the language server doesn't connect (pytest fixtures and
 * the tests that request them). A provider answers only for positions it owns; the first
 * answer wins, and everywhere else the server's answer is used as before.
 */
import type { EditorView } from "@codemirror/view";
import type { Location, Pos, RequestId, WorkspaceEdit } from "@/platform/ipc";

export interface UsageQuery {
  doc: number;
  path: string;
  pos: Pos;
}

/** Usages of the symbol at `query`, or null when the provider doesn't own that position. */
type UsageProvider = (query: UsageQuery, request: RequestId) => Promise<Location[] | null>;

export interface ContributedRename {
  /** The name being renamed, in the editor's document. */
  from: number;
  to: number;
  /** Why it can't be renamed (defined outside the project, …); the rename stops with this hint. */
  refused?: string;
  /** The edit renaming it to `newName`. */
  edit: (newName: string, request: RequestId) => Promise<WorkspaceEdit>;
}

type RenameProvider = (view: EditorView, offset: number) => Promise<ContributedRename | null>;

const usageProviders = new Set<UsageProvider>();
const renameProviders = new Set<RenameProvider>();

export function registerUsageProvider(provider: UsageProvider): () => void {
  usageProviders.add(provider);
  return () => void usageProviders.delete(provider);
}

export function registerRenameProvider(provider: RenameProvider): () => void {
  renameProviders.add(provider);
  return () => void renameProviders.delete(provider);
}

export async function contributedUsages(query: UsageQuery, request: RequestId): Promise<Location[] | null> {
  for (const provider of usageProviders) {
    // oxlint-disable-next-line no-await-in-loop -- first owner wins
    const found = await provider(query, request).catch(() => null);
    if (found) return found;
  }
  return null;
}

export async function contributedRename(view: EditorView, offset: number): Promise<ContributedRename | null> {
  for (const provider of renameProviders) {
    // oxlint-disable-next-line no-await-in-loop -- first owner wins
    const found = await provider(view, offset).catch(() => null);
    if (found) return found;
  }
  return null;
}
