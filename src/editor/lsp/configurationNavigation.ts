/** Shared, bounded navigation results for YAML/properties hover and click. */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { onEditorEvent } from "@/editor/api";
import { commands, IpcError, onIdeEvent, type GotoKind, type Location } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onServerSettled } from "./availability";
import { docOf, lspRequest } from "./lsp";
import { offsetToPos } from "./positions";

// Events provide invalidation; the age limit is a backstop for servers/remote
// file systems which do not report every semantic change. Empty/error responses
// are never retained, since import may still be in progress.
export const CONFIGURATION_NAVIGATION_MAX_AGE = 30_000;
const MAX_ENTRIES = 128;
const MAX_LOCATIONS = 4096;
interface Cached {
  text: Text;
  path: string;
  at: number;
  size: number;
  retain: boolean;
  pending: Promise<Location[]>;
}
const results = new Map<string, Cached>();
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

/** Indexing/refresh can be progress from this very lookup. Do not cancel an
 * explicit click when its own server task finishes; simply don't retain that
 * answer. Source edits/restarts still invalidate the request generation. */
function refreshConfigurationNavigation() {
  for (const [key, entry] of results) {
    entry.retain = false;
    if (entry.size) results.delete(key);
  }
}

export function hasConfigurationNavigation(view: EditorView, offset: number): boolean {
  const doc = docOf(view);
  const word = view.state.wordAt(offset);
  if (!doc || !word) return false;
  const entry = results.get(`${doc.doc}:${word.from}:${word.to}`);
  return (
    !!entry &&
    entry.size > 0 &&
    entry.retain &&
    entry.path === doc.path &&
    entry.text.eq(view.state.doc) &&
    Date.now() - entry.at < CONFIGURATION_NAVIGATION_MAX_AGE
  );
}

export function requestNavigation(view: EditorView, offset: number, kind: GotoKind): Promise<Location[]> {
  const doc = docOf(view)!;
  const word = view.state.wordAt(offset);
  if (!isConfigurationDocument(view) || kind !== "definition" || !word)
    return lspRequest(() => commands.lspGoto(doc.doc, offsetToPos(view.state.doc, offset), kind));
  const key = `${doc.doc}:${word.from}:${word.to}`;
  const text = view.state.doc;
  const hit = results.get(key);
  if (
    hit &&
    hit.path === doc.path &&
    hit.text.eq(text) &&
    Date.now() - hit.at < (hit.size ? CONFIGURATION_NAVIGATION_MAX_AGE : 3000)
  ) {
    results.delete(key);
    results.set(key, hit);
    return hit.pending;
  }
  const version = revision;
  const entry: Cached = {
    text,
    path: doc.path,
    at: Date.now(),
    size: 0,
    retain: true,
    pending: lspRequest(
      () => commands.lspGoto(doc.doc, offsetToPos(text, word.from), kind),
      () => revision === version,
    )
      .then((locations) => {
        if (revision !== version || !view.state.doc.eq(text))
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
    onIdeEvent("fsChanged", clear),
    onIdeEvent("excludedDirsChanged", clear),
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
