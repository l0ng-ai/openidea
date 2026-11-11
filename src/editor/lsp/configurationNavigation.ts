/**
 * Shared, bounded navigation results per word: the ⌘-hover probe, ⌘-click and ⌘B on one
 * word ask the server once. Each identical request costs a server like jdtls a full search.
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { onEditorEvent } from "@/editor/api";
import { commands, IpcError, onIdeEvent, type GotoKind, type Location } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onServerSettled } from "./availability";
import { docOf, lspRequest } from "./lsp";
import { offsetToPos } from "./positions";

// Events provide invalidation; the age limit is a backstop for servers/remote
// file systems which do not report every semantic change, and for a request the
// backend never answers (it times out sooner). Empty/error responses are never
// retained, since a server may still be importing or indexing.
export const CONFIGURATION_NAVIGATION_MAX_AGE = 30_000;
const MAX_ENTRIES = 128;
const MAX_LOCATIONS = 4096;
const SHARED_KINDS: ReadonlySet<GotoKind> = new Set(["definition", "declaration", "typeDefinition"]);
interface Cached {
  text: Text;
  path: string;
  at: number;
  size: number;
  retain: boolean;
  pending: Promise<Location[]>;
}
const results = new Map<string, Cached>();
const editors = new WeakMap<EditorView, number>();
let nextEditor = 0;

function requestKey(view: EditorView, from: number, to: number, kind: GotoKind): string {
  let editor = editors.get(view);
  if (editor === undefined) editors.set(view, (editor = ++nextEditor));
  const doc = docOf(view)!;
  // lspGoto chooses servers in the backend; revision also tracks server lifecycle and routing changes.
  return `${editor}:${doc.doc}:${doc.language}:${revision}:${from}:${to}:${kind}`;
}
let revision = 0;

export function configurationNavigationRevision(): number {
  return revision;
}

export function invalidateConfigurationNavigation() {
  revision++;
  results.clear();
}

export function isConfigurationDocument(view: EditorView): boolean {
  const language = docOf(view)?.language;
  return language === "yaml" || language === "properties";
}

/** Configuration names include hyphens and dots even when the editor's
 * language word rules split them. Share this range between decoration and lookup. */
export function navigationWord(view: EditorView, offset: number): { from: number; to: number } | null {
  if (!isConfigurationDocument(view)) return view.state.wordAt(offset);
  const line = view.state.doc.lineAt(offset);
  const nameChar = /[\p{L}\p{N}_.$-]/u;
  let from = offset - line.from;
  let to = from;
  while (from > 0 && nameChar.test(line.text[from - 1]!)) from--;
  while (to < line.text.length && nameChar.test(line.text[to]!)) to++;
  return from < to ? { from: line.from + from, to: line.from + to } : null;
}

/** Indexing/refresh can be progress from this very lookup, and file changes the
 * build writing its output after an edit. Do not cancel an explicit click for
 * them; simply don't retain that answer. Source edits/restarts still invalidate
 * the request generation. */
function refreshConfigurationNavigation() {
  for (const [key, entry] of results) {
    entry.retain = false;
    if (entry.size) results.delete(key);
  }
}

export function hasConfigurationNavigation(view: EditorView, offset: number): boolean {
  const doc = docOf(view);
  const word = navigationWord(view, offset);
  if (!doc || !word) return false;
  const entry = results.get(requestKey(view, word.from, word.to, "definition"));
  return (
    !!entry &&
    entry.size > 0 &&
    entry.retain &&
    entry.path === doc.path &&
    entry.text === view.state.doc &&
    Date.now() - entry.at < CONFIGURATION_NAVIGATION_MAX_AGE
  );
}

export function requestNavigation(view: EditorView, offset: number, kind: GotoKind): Promise<Location[]> {
  const doc = docOf(view)!;
  const word = navigationWord(view, offset);
  const config = isConfigurationDocument(view);
  if (!word || !(config ? kind === "definition" : SHARED_KINDS.has(kind)))
    return lspRequest(() => commands.lspGoto(doc.doc, offsetToPos(view.state.doc, offset), kind));
  const key = requestKey(view, word.from, word.to, kind);
  const text = view.state.doc;
  const hit = results.get(key);
  if (hit && hit.path === doc.path && hit.text === text && Date.now() - hit.at < CONFIGURATION_NAVIGATION_MAX_AGE) {
    results.delete(key);
    results.set(key, hit);
    return hit.pending;
  }
  const version = revision;
  // Just past a word's end some servers resolve the next token, so the shared answer is asked inside the word.
  const at = config ? word.from : Math.min(offset, word.to - 1);
  const entry: Cached = {
    text,
    path: doc.path,
    at: Date.now(),
    size: 0,
    retain: true,
    pending: lspRequest(
      () => commands.lspGoto(doc.doc, offsetToPos(text, at), kind),
      () => revision === version && view.state.doc === text && docOf(view) === doc && view.dom.isConnected,
    )
      .then((locations) => {
        if (revision !== version || view.state.doc !== text || docOf(view) !== doc || !view.dom.isConnected)
          throw new IpcError({ kind: "cancelled", message: "cancelled" });
        entry.size = locations.length;
        if ((!locations.length || !entry.retain) && results.get(key) === entry) results.delete(key);
        let size = 0;
        for (const value of results.values()) size += value.size;
        while (size > MAX_LOCATIONS && results.size) {
          const oldest = results.keys().next().value!;
          size -= results.get(oldest)!.size;
          results.delete(oldest);
        }
        return locations;
      })
      .catch((error: unknown) => {
        if (results.get(key) === entry) results.delete(key);
        throw error;
      }),
  };
  results.delete(key);
  results.set(key, entry);
  while (results.size > MAX_ENTRIES) results.delete(results.keys().next().value!);
  return entry.pending;
}

export function installConfigurationNavigationEvents(): () => void {
  const clear = invalidateConfigurationNavigation;
  const off = [
    onIdeEvent("fsChanged", refreshConfigurationNavigation),
    onIdeEvent("excludedDirsChanged", refreshConfigurationNavigation),
    onIdeEvent("docPatched", clear),
    onIdeEvent("docLanguage", clear),
    onIdeEvent("workspaceEditApplied", clear),
    onIdeEvent("lspRefresh", refreshConfigurationNavigation),
    onIdeEvent("languageServer", (e) => {
      if (e.status === "starting" || e.status === "stopped" || e.status === "crashed") clear();
    }),
    onIdeEvent("languageServerRemoved", clear),
    onServerSettled(refreshConfigurationNavigation),
    onEditorEvent((e) => {
      // Closing an unsaved Java buffer restores its on-disk declarations.
      if (e.type === "docClosed" || e.type === "docSaved") clear();
    }),
    useProject.subscribe((s, previous) => {
      if (s.project?.root !== previous.project?.root) clear();
    }),
  ];
  return () => {
    off.forEach((dispose) => dispose());
    clear();
  };
}
