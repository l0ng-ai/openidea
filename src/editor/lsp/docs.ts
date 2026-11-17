/**
 * Quick Documentation navigation, as in IDEA: links to other symbols open
 * their documentation in place (⌘-click opens the source instead), ← / →
 * walk the history, Edit Source (F4) jumps to the declaration, and F1 on a
 * focused popup moves it to the Documentation tool window, which then shows
 * F1's documentation instead of a popup while it is open. The hover's
 * documentation is the same view with its own history.
 */
import { create, createStore, type StoreApi } from "zustand";
import { commands, nextRequestId, type Location } from "@/platform/ipc";
import { hasPrimaryModifier } from "@/platform/keymap";
import { editorService, maybeEditorService, toolWindowService } from "@/workbench/contributions";
import { closePopup, updatePopup, useLspPopup, type DocEntry } from "./popupStore";
import { isEmptyMarkup, languageForPath, sourceLink, type DocLinkHandler } from "./markdown";
import { lspRequest } from "./lsp";
import { readFileLines, withDocument } from "./files";

export const DOCUMENTATION_WINDOW = "documentation";

export interface DocHistory {
  entries: DocEntry[];
  index: number;
}

/** History after following a link from the shown entry: forward entries are dropped. */
export function pushHistory(h: DocHistory, entry: DocEntry): DocHistory {
  return { entries: [...h.entries.slice(0, h.index + 1), entry], index: h.index + 1 };
}

/** History index after ← (-1) / → (+1); unchanged at the ends. */
export function stepHistory(h: DocHistory, delta: -1 | 1): number {
  return Math.max(0, Math.min(h.entries.length - 1, h.index + delta));
}

// ---------------------------------------------------------------------------
// Documentation tool window

interface DocWindowState extends DocHistory {
  themeClasses: string;
}

export const useDocWindow = create<DocWindowState>(() => ({ entries: [], index: 0, themeClasses: "" }));

export function docWindowVisible(): boolean {
  try {
    return toolWindowService().isVisible(DOCUMENTATION_WINDOW);
  } catch {
    return false;
  }
}

/** Shows `entry` in the Documentation tool window (a new history step). */
export function showInDocWindow(entry: DocEntry, themeClasses: string) {
  useDocWindow.setState((s) => ({ ...pushHistory(s, entry), themeClasses: themeClasses || s.themeClasses }));
  toolWindowService().show(DOCUMENTATION_WINDOW, false);
}

/** F1 on a focused documentation popup: the popup's (or the hover's) history moves to the tool window. */
export function moveDocPopupToWindow(host: "popup" | HoverDoc = "popup"): boolean {
  const h = history(host);
  if (!h) return false;
  const popup = useLspPopup.getState().popup;
  const themeClasses = host === "popup" && popup?.kind === "doc" ? popup.themeClasses : "";
  useDocWindow.setState((s) => ({ entries: h.entries, index: h.index, themeClasses: themeClasses || s.themeClasses }));
  closeHost(host);
  toolWindowService().show(DOCUMENTATION_WINDOW, true);
  return true;
}

// ---------------------------------------------------------------------------
// Hover documentation: each hover tooltip keeps its own history (an editor that comes back
// into view brings its open hover back too).

interface HoverDocState extends DocHistory {
  close: () => void;
}

export type HoverDoc = StoreApi<HoverDocState>;

export function hoverDoc(entry: DocEntry, close: () => void): HoverDoc {
  return createStore<HoverDocState>(() => ({ entries: [entry], index: 0, close }));
}

/** The size the documentation popup was last resized to, kept across sessions as IDEA does. */
const DOC_SIZE_KEY = "openidea.lsp.docPopupSize";
export const DOC_MIN_WIDTH = 240;
export const DOC_MIN_HEIGHT = 120;

export function loadDocSize(): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(DOC_SIZE_KEY) ?? "null") as { w?: unknown; h?: unknown } | null;
    return typeof v?.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : null;
  } catch {
    return null;
  }
}

export function saveDocSize(size: { w: number; h: number }) {
  try {
    localStorage.setItem(DOC_SIZE_KEY, JSON.stringify(size));
  } catch {
    // Storage unavailable: the next popup opens at its default size.
  }
}

// ---------------------------------------------------------------------------
// Shared by the popup and the tool window

/** Where a doc view keeps its history: the F1 popup, the hover or the tool window. */
export type DocHost = "popup" | "window" | HoverDoc;

function history(host: DocHost): DocHistory | null {
  if (host === "window") return useDocWindow.getState();
  if (typeof host === "object") return host.getState();
  const p = useLspPopup.getState().popup;
  return p?.kind === "doc" ? p : null;
}

function setHistory(host: DocHost, h: DocHistory) {
  if (host === "window") useDocWindow.setState(h);
  else if (typeof host === "object") host.setState(h);
  else updatePopup("doc", h);
}

/** Closes the popup or the hover a link or Edit Source leaves; the tool window stays. */
function closeHost(host: DocHost) {
  if (host === "popup") closePopup();
  else if (typeof host === "object") host.getState().close();
}

export function docStep(host: DocHost, delta: -1 | 1) {
  const h = history(host);
  if (h) setHistory(host, { entries: h.entries, index: stepHistory(h, delta) });
}

/** F4 / Edit Source: the documented element's declaration. */
export async function editDocSource(host: DocHost): Promise<boolean> {
  const h = history(host);
  const entry = h?.entries[h.index];
  const loc = (await entry?.source?.().catch(() => null)) ?? null;
  if (!loc) return false;
  closeHost(host);
  await editorService().openFile(loc.path, {
    selection: { line: loc.range.start.line, col: loc.range.start.col },
    focus: true,
  });
  return true;
}

const DECLARATION_KEYWORDS =
  /^(export|default|declare|abstract|public|private|protected|internal|static|final|async|const|let|var|val|function|fun|fn|func|def|class|interface|struct|enum|trait|type|impl|pub|mod|object|record|override|readonly|open|data|sealed|extends|implements)$/;

/**
 * Positions on the linked line worth asking the server about: the link's own
 * column, then the identifiers after declaration keywords (links often point
 * at the start of `export class Foo`).
 */
export function hoverCandidates(lineText: string, col: number): number[] {
  const out = [col];
  const re = /[A-Za-z_$][\w$]*/g;
  for (let m = re.exec(lineText); m && out.length < 5; m = re.exec(lineText)) {
    if (m.index < col || DECLARATION_KEYWORDS.test(m[0])) continue;
    if (!out.includes(m.index)) out.push(m.index);
  }
  return out;
}

async function docAt(target: { path: string; line: number; col: number }): Promise<DocEntry | null> {
  const line = (await readFileLines(target.path))?.[target.line] ?? "";
  return withDocument(target.path, async (doc) => {
    for (const col of hoverCandidates(line, target.col)) {
      const hover = await lspRequest(() => commands.lspHover(nextRequestId(), doc, { line: target.line, col })).catch(
        () => null,
      );
      if (hover && !isEmptyMarkup(hover.contents)) {
        const location: Location = {
          path: target.path,
          range: { start: { line: target.line, col }, end: { line: target.line, col } },
        };
        return { markup: hover.contents, language: languageForPath(target.path), source: async () => location };
      }
    }
    return null;
  });
}

/**
 * Link clicks in a documentation view: a source link shows that symbol's
 * documentation in the same view (⌘-click opens the source instead).
 */
export function docLinkHandler(host: DocHost): DocLinkHandler {
  return (href, e) => {
    const target = sourceLink(href);
    if (!target || hasPrimaryModifier(e)) {
      if (target) closeHost(host);
      return false;
    }
    void (async () => {
      const entry = await docAt(target).catch(() => null);
      const h = history(host);
      if (!entry || !h) {
        closeHost(host);
        void maybeEditorService()?.openFile(target.path, {
          selection: { line: target.line, col: target.col },
          focus: true,
        });
        return;
      }
      setHistory(host, pushHistory(h, entry));
    })();
    return true;
  };
}
