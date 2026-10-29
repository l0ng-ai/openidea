/**
 * One DocModel per open backend document (shared by every tab / split
 * showing the file) and the manager that opens, saves and closes them.
 */
import { ChangeSet, Transaction, type Annotation, type EditorState, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { create } from "zustand";
import type { EditorConfigProps } from "@/bindings";
import type {
  DocId,
  DocumentInfo,
  EditorSettings,
  FileSettings,
  LineEnding,
  OutlineItem,
  Settings,
  SyntaxHighlights,
} from "@/platform/ipc";
import {
  _emitEditorEvent,
  _saveParticipants,
  isLibraryPath,
  mirroredChange,
  remoteChange,
  useEditorRegistry,
  type EditorDocContext,
} from "@/editor/api";
import { isVirtualUri } from "@/platform/virtualDocs";
import { DocSync, type Scheduler, frameScheduler } from "../sync/DocSync";
import type { DocBackend, LanguageInfo } from "../backend";
import {
  findLanguageDescription,
  languageInfo,
  loadLanguageInfos,
  loadSupport,
  loadedSupport,
  commentTokens,
} from "../cm/languages";
import { foldEffect } from "@codemirror/language";
import { backendFolds, setBackendFolds } from "../cm/folding";
import { setSyntaxHighlights } from "../cm/syntaxHighlight";
import {
  caretFor,
  compartments,
  detectIndent,
  distractionFreeExtension,
  effectiveIndent,
  foldingFor,
  fontExtension,
  heavyExtension,
  indentExtension,
  lineNumbersExtension,
  prefsFor,
  prefsOf,
  readOnlyExtension,
  stickyExtension,
  wrapExtension,
  HEAVY_LIMIT,
} from "../cm/setup";
import { setMethodLines, softWrapActive } from "../cm/prefs";
import type { EditorSlot } from "./slot";
import { tx } from "@/platform/i18n";

export type Banner = "binary" | "tooLarge" | "readOnly" | "library" | null;

/** A view attached to a document outside the tab system (see `attachment.ts`). */
export interface DocAttachmentTarget {
  /** Applies changes that are already in the model (another view / the backend). */
  applyExternal(changes: ChangeSet, annotations: Annotation<unknown>[]): void;
}

export interface DocMeta {
  doc: DocId;
  path: string;
  language: string;
  uiMode: string | null;
  encoding: string;
  lineEnding: LineEnding;
  readOnly: boolean;
  dirty: boolean;
  banner: Banner;
  indent: { tabSize: number; insertSpaces: boolean };
}

/** Reactive per-path document metadata (tabs, status bar, banners). */
export const useDocMeta = create<Record<string, DocMeta>>(() => ({}));
/** Outline per path for breadcrumbs (refreshed after edits settle). */
export const useOutline = create<Record<string, OutlineItem[]>>(() => ({}));

const REFRESH_DELAY = 450;
function bannerFor(info: DocumentInfo): Banner {
  // Virtual documents (library classes) get their own notice from the editor area.
  if (info.uri) return null;
  if (isLibraryPath(info.path)) return "library";
  if (!info.readOnly) return null;
  if (!info.text.length) return "binary";
  // The backend makes files above its size limit read-only and flags them `large`.
  if (info.large) return "tooLarge";
  return "readOnly";
}

/** Ranges touched since the last save (in current-document coordinates). */
export class ModifiedRanges {
  ranges: Array<[number, number]> = [];
  all = false;

  map(changes: ChangeSet) {
    if (this.all) return;
    this.ranges = this.ranges.map(([a, b]): [number, number] => [changes.mapPos(a, -1), changes.mapPos(b, 1)]);
  }

  add(changes: ChangeSet) {
    if (this.all) return;
    this.map(changes);
    changes.iterChangedRanges((_fa, _ta, fromB, toB) => this.ranges.push([fromB, toB]), true);
    if (this.ranges.length > 2000) {
      this.ranges.sort((x, y) => x[0] - y[0]);
      const merged: Array<[number, number]> = [];
      for (const r of this.ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      }
      this.ranges = merged;
      if (merged.length > 2000) this.all = true;
    }
  }

  clear() {
    this.ranges = [];
    this.all = false;
  }
}

/** 0-based start lines of functions / methods in an outline (method separators). */
export function methodLines(items: readonly OutlineItem[]): number[] {
  const out: number[] = [];
  const walk = (list: readonly OutlineItem[]) => {
    for (const it of list) {
      if (it.kind === "function" || it.kind === "method" || it.kind === "constructor") out.push(it.range.start.line);
      walk(it.children);
    }
  };
  walk(items);
  return out.sort((a, b) => a - b);
}

/**
 * Save cleanup: trailing whitespace on touched (or all) lines except caret
 * lines, trailing blank lines at the end, and the final newline.
 */
export function saveCleanupChanges(
  state: EditorState,
  modified: ModifiedRanges,
  opts: {
    trim: boolean;
    finalNewline: boolean;
    protectLines: Set<number>;
    allLines?: boolean;
    trailingBlankLines?: boolean;
  },
): Array<{ from: number; to: number; insert?: string }> {
  const changes: Array<{ from: number; to: number; insert?: string }> = [];
  const doc = state.doc;
  let blankFrom = doc.length;
  if (opts.trailingBlankLines) {
    // Keep exactly one line break after the last non-blank line.
    const m = /\n[ \t\n]*$/.exec(doc.sliceString(Math.max(0, doc.length - 10_000)));
    if (m && m[0].indexOf("\n", 1) >= 0) blankFrom = doc.length - m[0].length + 1;
  }
  if (opts.trim) {
    const lines = new Set<number>();
    if (modified.all || opts.allLines) for (let n = 1; n <= doc.lines; n++) lines.add(n);
    else
      for (const [a, b] of modified.ranges) {
        const from = doc.lineAt(Math.min(a, doc.length)).number;
        const to = doc.lineAt(Math.min(b, doc.length)).number;
        for (let n = from; n <= to; n++) lines.add(n);
      }
    for (const n of [...lines].sort((x, y) => x - y)) {
      if (opts.protectLines.has(n)) continue;
      const line = doc.line(n);
      if (line.from >= blankFrom) break;
      const m = /[ \t]+$/.exec(line.text);
      if (m) changes.push({ from: line.from + m.index, to: line.to });
    }
  }
  if (blankFrom < doc.length) changes.push({ from: blankFrom, to: doc.length });
  else if (opts.finalNewline && doc.length > 0 && doc.sliceString(doc.length - 1) !== "\n")
    changes.push({ from: doc.length, to: doc.length, insert: "\n" });
  return changes;
}

export class DocModel {
  readonly doc: DocId;
  /** File path, or the URI of a virtual (read-only, language-server provided) document. */
  readonly path: string;
  readonly virtual: boolean;
  readonly sync: DocSync;
  readonly slots = new Set<EditorSlot>();
  /** Views outside the tab system sharing this document (e.g. the editable side of a diff). */
  readonly attachments = new Set<DocAttachmentTarget>();
  readonly modified = new ModifiedRanges();
  info: LanguageInfo | undefined;
  /** Effective `.editorconfig` properties at open time. */
  editorconfig: EditorConfigProps | null = null;
  desc: LanguageDescription | null;
  language: LanguageSupport | null;
  /** Too large for language support (no CodeMirror language, backend highlighting only). */
  private large: boolean;
  lastFocused: EditorSlot | null = null;
  /** Bumped by every change (local or remote). */
  changeCounter = 0;
  closed = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private meta: DocMeta;

  constructor(
    readonly manager: DocumentManager,
    info: DocumentInfo,
  ) {
    this.doc = info.id;
    this.path = info.path;
    this.virtual = !!info.uri;
    this.info = languageInfo(info.language);
    this.editorconfig = info.editorconfig ?? null;
    // `large`: the backend skips LSP and syntax trees for it; heavy UI features follow.
    const large = !!info.large || info.text.length > HEAVY_LIMIT;
    this.large = large;
    this.desc = large ? null : findLanguageDescription(this.info?.uiMode ?? null, info.path);
    this.language = loadedSupport(this.desc);
    this.meta = {
      doc: info.id,
      path: info.path,
      language: info.language,
      uiMode: this.info?.uiMode ?? this.desc?.name ?? null,
      encoding: info.encoding,
      lineEnding: info.lineEnding,
      // Library sources (External Libraries) open read-only, like IDEA's.
      readOnly: info.readOnly || (!this.virtual && isLibraryPath(info.path)),
      dirty: info.dirty,
      banner: bannerFor(info),
      indent: { tabSize: 4, insertSpaces: true },
    };
    this.detectedIndent = info.readOnly && !info.text.length ? null : detectIndent(info.text.slice(0, 200_000));
    this.meta.indent = this.effectiveIndent();
    useDocMeta.setState({ [this.path]: this.meta });
    this.sync = new DocSync(
      info.version,
      info.text,
      {
        edit: (base, changes) => manager.backend.edit(this.doc, base, changes),
        snapshot: () => manager.backend.snapshot(this.doc),
      },
      {
        applyRemote: (cs) => this.applyRemote(cs),
        onDiscarded: () =>
          manager.notify({
            level: "warning",
            title: "Editor resynchronised",
            body: tx`Some unsaved edits to ${this.path} could not be applied and were replaced by the file's current content.`,
          }),
        onError: (e) => console.warn(`document ${this.path}: sync error`, e),
      },
      manager.scheduler,
    );
    if (this.desc && !this.language) void this.loadLanguage();
    this.scheduleRefresh(0);
  }

  getMeta(): DocMeta {
    return this.meta;
  }

  setMeta(patch: Partial<DocMeta>) {
    this.meta = { ...this.meta, ...patch };
    if (!this.closed) useDocMeta.setState({ [this.path]: this.meta });
  }

  ctx(): EditorDocContext {
    return {
      doc: this.doc,
      path: this.path,
      language: this.meta.language,
      uiMode: this.meta.uiMode,
      readOnly: this.meta.readOnly,
      ...(this.virtual ? { virtual: true } : {}),
    };
  }

  settings(): EditorSettings | undefined {
    return this.manager.settings()?.editor;
  }

  addSlot(slot: EditorSlot) {
    this.slots.add(slot);
    if (this.highlights?.counter === this.changeCounter)
      slot.reconfigure([setSyntaxHighlights.of(this.highlights.value)]);
  }

  removeSlot(slot: EditorSlot) {
    this.slots.delete(slot);
    if (this.lastFocused === slot) this.lastFocused = null;
    if (!this.inUse()) this.manager.release(this);
  }

  attach(target: DocAttachmentTarget) {
    this.attachments.add(target);
  }

  detach(target: DocAttachmentTarget) {
    this.attachments.delete(target);
    if (!this.inUse()) this.manager.release(this);
  }

  /** Shown by a tab or an attached view. */
  inUse(): boolean {
    return this.slots.size > 0 || this.attachments.size > 0;
  }

  /** The slot to apply programmatic edits through. */
  primarySlot(): EditorSlot | null {
    if (this.lastFocused && this.slots.has(this.lastFocused)) return this.lastFocused;
    for (const s of this.slots) if (s.view) return s;
    return this.slots.values().next().value ?? null;
  }

  onLocal(changes: ChangeSet, origin: EditorSlot | DocAttachmentTarget) {
    this.sync.local(changes);
    this.modified.add(changes);
    this.changeCounter++;
    for (const s of this.slots)
      if (s !== origin) s.applyExternal(changes, [mirroredChange.of(true), Transaction.addToHistory.of(false)]);
    for (const a of this.attachments)
      if (a !== origin) a.applyExternal(changes, [mirroredChange.of(true), Transaction.addToHistory.of(false)]);
    if (!this.meta.dirty) this.setMeta({ dirty: true });
    this.scheduleRefresh();
  }

  private applyRemote(cs: ChangeSet) {
    this.modified.map(cs);
    this.changeCounter++;
    const primary = this.primarySlot();
    for (const s of this.slots)
      s.applyExternal(cs, [remoteChange.of(true), Transaction.addToHistory.of(s === primary)]);
    // Without a tab, the first attached view keeps backend edits (Replace in Files…) undoable.
    let first = !primary;
    for (const a of this.attachments) {
      a.applyExternal(cs, [remoteChange.of(true), Transaction.addToHistory.of(first)]);
      first = false;
    }
    this.scheduleRefresh();
  }

  /** The backend detected another language (Settings › File Types, Override File Type). */
  setLanguage(language: string) {
    if (this.closed || language === this.meta.language) return;
    this.info = languageInfo(language);
    this.desc = this.large ? null : findLanguageDescription(this.info?.uiMode ?? null, this.path);
    this.language = loadedSupport(this.desc);
    this.highlights = null;
    this.setMeta({ language, uiMode: this.info?.uiMode ?? this.desc?.name ?? null });
    for (const s of this.slots) {
      s.reconfigure([compartments.language.reconfigure(this.language ?? [])]);
      s.syncContributions(true);
    }
    this.applySettings();
    if (this.desc && !this.language) void this.loadLanguage();
    this.scheduleRefresh(0);
  }

  async loadLanguage() {
    if (!this.desc) return;
    const support = await loadSupport(this.desc);
    if (!support || this.closed || this.language === support) return;
    this.language = support;
    for (const s of this.slots) s.reconfigure([compartments.language.reconfigure(support)]);
  }

  /** Per-file indentation chosen from the status bar; wins over settings until the file is closed. */
  indentOverride: { tabSize: number; insertSpaces: boolean } | null = null;
  /** Indentation detected in the file's text at open time. */
  detectedIndent: { insertSpaces: boolean; size?: number } | null = null;
  /** Last tree-sitter highlighting, for slots opened before the next refresh. */
  private highlights: { counter: number; value: SyntaxHighlights } | null = null;
  /** Fold-by-default has been applied (first folding ranges of the document). */
  private initialFolds = false;
  /** Signature of settings that require contributions to be rebuilt. */
  private contributionPrefs = "";

  effectiveIndent() {
    return this.indentOverride ?? effectiveIndent(this.settings(), this.info, this.editorconfig, this.detectedIndent);
  }

  /** Soft wraps toggled for this file (wins over settings until the file is closed). */
  softWrapOverride: boolean | null = null;

  softWrapOn(): boolean {
    const editor = this.settings();
    return this.softWrapOverride ?? softWrapActive(editor?.softWrap, prefsOf(editor), this.path);
  }

  toggleSoftWrap() {
    this.softWrapOverride = !this.softWrapOn();
    this.applySettings();
  }

  setIndent(indent: { tabSize: number; insertSpaces: boolean }) {
    this.indentOverride = indent;
    this.applySettings();
  }

  /** Re-applies settings-derived compartments (settings changed). */
  applySettings() {
    const editor = this.settings();
    const indent = this.effectiveIndent();
    this.setMeta({ indent: { tabSize: indent.tabSize, insertSpaces: indent.insertSpaces } });
    const effects = [
      compartments.indent.reconfigure(indentExtension(indent)),
      compartments.wrap.reconfigure(wrapExtension(editor, this.path, this.softWrapOverride)),
      compartments.sticky.reconfigure(stickyExtension(editor)),
      compartments.font.reconfigure(fontExtension(editor)),
      compartments.comments.reconfigure(commentTokens(this.info, this.meta.language)),
      compartments.lineNumbers.reconfigure(lineNumbersExtension(editor)),
      compartments.folding.reconfigure(foldingFor(editor)),
      compartments.caret.reconfigure(caretFor(editor)),
      compartments.heavy.reconfigure(heavyExtension(this.sync.localText.length, editor)),
      compartments.distractionFree.reconfigure(distractionFreeExtension(editor)),
      compartments.prefs.reconfigure(
        prefsFor({
          settings: editor,
          path: this.path,
          info: this.info,
          readOnly: this.meta.readOnly,
          wrapOverride: this.softWrapOverride,
        }),
      ),
    ];
    // LSP contributions read completion / hover timings when they are built.
    const p = prefsOf(editor);
    const sig = JSON.stringify([p.codeEditing.quickDocDelay, p.completion.autoPopup]);
    const rebuild = !!this.contributionPrefs && sig !== this.contributionPrefs;
    this.contributionPrefs = sig;
    for (const s of this.slots) {
      s.reconfigure(effects);
      if (rebuild) s.syncContributions(true);
    }
  }

  setReadOnly(readOnly: boolean) {
    if (readOnly === this.meta.readOnly) return;
    const banner = this.meta.banner;
    this.setMeta({
      readOnly,
      banner: readOnly
        ? (banner ?? (this.virtual ? null : "readOnly"))
        : banner === "readOnly" || banner === "library"
          ? null
          : banner,
    });
    for (const s of this.slots) {
      s.reconfigure([
        compartments.readOnly.reconfigure(readOnlyExtension(readOnly)),
        compartments.prefs.reconfigure(
          prefsFor({
            settings: this.settings(),
            path: this.path,
            info: this.info,
            readOnly,
            wrapOverride: this.softWrapOverride,
          }),
        ),
      ]);
      s.syncContributions(true);
    }
  }

  setHeavy() {
    const len = this.sync.localText.length;
    for (const s of this.slots) s.reconfigure([compartments.heavy.reconfigure(heavyExtension(len, this.settings()))]);
  }

  // --- background refresh (folding ranges, outline) -------------------------

  scheduleRefresh(delay = REFRESH_DELAY) {
    if (this.meta.banner === "binary" || this.meta.banner === "tooLarge") return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  private async refresh() {
    if (this.closed) return;
    await this.sync.whenIdle();
    const counter = this.changeCounter;
    const backend = this.manager.backend;
    const [folds, outline, highlights] = await Promise.allSettled([
      backend.folding(this.doc),
      backend.outline(this.doc),
      // Without a CodeMirror mode, colours come from the grammar's tree-sitter query.
      this.desc ? null : backend.highlights(this.doc),
    ]);
    if (this.closed) return;
    if (counter !== this.changeCounter) {
      this.scheduleRefresh();
      return;
    }
    if (folds.status === "fulfilled") {
      for (const s of this.slots) s.reconfigure([setBackendFolds.of(folds.value)]);
      if (!this.initialFolds) {
        this.initialFolds = true;
        this.foldByDefault();
      }
    }
    if (highlights.status === "fulfilled" && highlights.value) {
      this.highlights = { counter, value: highlights.value };
      for (const s of this.slots) s.reconfigure([setSyntaxHighlights.of(highlights.value)]);
    }
    if (outline.status === "fulfilled") {
      useOutline.setState({ [this.path]: outline.value });
      const lines = methodLines(outline.value);
      for (const s of this.slots) s.reconfigure([setMethodLines.of(lines)]);
    }
  }

  /** Code Folding › "Fold by default": file header, imports, documentation comments. */
  private foldByDefault() {
    const f = prefsOf(this.settings()).folding;
    if (!f.fileHeader && !f.imports && !f.docComments) return;
    for (const s of this.slots) {
      const state = s.currentState();
      const folds = state.field(backendFolds, false) ?? [];
      const firstCode = (() => {
        for (let n = 1; n <= state.doc.lines; n++) {
          const t = state.doc.line(n).text.trim();
          if (t && !t.startsWith("#!")) return state.doc.line(n).from;
        }
        return 0;
      })();
      const chosen = folds.filter((r) => {
        if (r.kind === "imports") return f.imports;
        if (r.kind !== "comment") return false;
        const header = state.doc.lineAt(r.from).from <= firstCode;
        return header ? f.fileHeader : f.docComments;
      });
      const effects: StateEffect<unknown>[] = chosen.map((r) => foldEffect.of({ from: r.from, to: r.to }));
      // Folding the header / imports shifts everything below: keep a navigation
      // target (caret revealed on open) in view.
      const head = state.selection.main.head;
      if (effects.length && head > 0 && !chosen.some((r) => r.from < head && head <= r.to))
        effects.push(EditorView.scrollIntoView(head, { y: "center" }));
      if (effects.length) s.reconfigure(effects);
    }
  }

  // --- saving -----------------------------------------------------------------

  save(reason: "explicit" | "auto"): Promise<void> {
    const run = async () => {
      if (this.closed || this.meta.readOnly) return;
      if (reason === "auto" && !this.meta.dirty) return;
      const slot = this.primarySlot();
      if (reason === "explicit") {
        for (const p of _saveParticipants()) {
          try {
            await p.beforeSave(this.ctx(), slot?.handle ?? null, "explicit");
          } catch (e) {
            console.warn(`save participant ${p.id} failed`, e);
          }
        }
      }
      const files: FileSettings | undefined = this.manager.settings()?.files;
      if (slot && !this.closed) {
        const state = slot.currentState();
        const protectLines = new Set<number>();
        // Like IDEA's "keep trailing spaces on caret line": never strip under a visible caret.
        for (const s of this.slots) {
          if (!s.view) continue;
          const st = s.currentState();
          for (const r of st.selection.ranges) protectLines.add(st.doc.lineAt(r.head).number);
        }
        const g = prefsOf(this.settings()).general;
        const ec = prefsOf(this.settings()).codeStyle.editorconfig ? this.editorconfig : null;
        const changes = saveCleanupChanges(state, this.modified, {
          trim: ec?.trimTrailingWhitespace ?? files?.trimTrailingWhitespace ?? true,
          finalNewline: ec?.insertFinalNewline ?? files?.ensureFinalNewline ?? true,
          protectLines: g.keepTrailingOnCaretLine ? protectLines : new Set(),
          allLines: g.stripTrailingScope === "all",
          trailingBlankLines: g.removeTrailingBlankLines,
        });
        if (changes.length) slot.dispatchLocal({ changes, userEvent: "input.save" });
      }
      await this.sync.whenIdle();
      if (this.closed) return;
      await this.manager.backend.save(this.doc);
      this.modified.clear();
      this.setMeta({ dirty: false });
      _emitEditorEvent({ type: "docSaved", doc: this.doc, path: this.path });
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    this.sync.dispose();
  }
}

export interface ManagerHost {
  settings(): Settings | null | undefined;
  notify(n: { level: "info" | "warning" | "error"; title: string; body?: string }): void;
}

export class DocumentManager {
  readonly byPath = new Map<string, DocModel>();
  readonly byId = new Map<DocId, DocModel>();
  private opening = new Map<string, Promise<DocModel>>();
  contributionsVersion = 0;
  private disposers: Array<() => void> = [];

  constructor(
    readonly backend: DocBackend,
    private host: ManagerHost,
    readonly scheduler: Scheduler = frameScheduler,
  ) {}

  settings() {
    return this.host.settings();
  }

  notify(n: Parameters<ManagerHost["notify"]>[0]) {
    this.host.notify(n);
  }

  start() {
    this.disposers.push(
      this.backend.onPatched((e) => this.byId.get(e.doc)?.sync.remote(e)),
      this.backend.onLanguage?.((e) => this.byId.get(e.doc)?.setLanguage(e.language)) ?? (() => {}),
      this.backend.onDirty((e) => {
        const m = this.byId.get(e.doc);
        if (m && m.getMeta().dirty !== e.dirty) {
          m.setMeta({ dirty: e.dirty });
          if (!e.dirty) m.modified.clear();
        }
      }),
    );
    let prev = useEditorRegistry.getState().contributions;
    this.disposers.push(
      useEditorRegistry.subscribe((s) => {
        if (s.contributions === prev) return;
        prev = s.contributions;
        this.contributionsVersion++;
        for (const m of this.byPath.values()) for (const slot of m.slots) slot.syncContributions();
      }),
    );
    void loadLanguageInfos(this.backend);
  }

  stop() {
    this.disposers.splice(0).forEach((d) => d());
  }

  get(path: string): DocModel | undefined {
    return this.byPath.get(path);
  }

  /** Opens (or returns the already open) document model for `path`. */
  acquire(path: string): Promise<DocModel> {
    const existing = this.byPath.get(path);
    if (existing) return Promise.resolve(existing);
    let p = this.opening.get(path);
    if (!p) {
      p = (async () => {
        await loadLanguageInfos(this.backend);
        const info = isVirtualUri(path) ? await this.backend.openVirtual(path) : await this.backend.open(path);
        const raced = this.byPath.get(path);
        if (raced) {
          void this.backend.close(info.id);
          return raced;
        }
        const model = new DocModel(this, info);
        this.byPath.set(path, model);
        this.byId.set(model.doc, model);
        _emitEditorEvent({ type: "docOpened", doc: model.doc, path, language: info.language });
        return model;
      })().finally(() => this.opening.delete(path));
      this.opening.set(path, p);
    }
    return p;
  }

  /** Called when the last slot of a model goes away. */
  release(model: DocModel) {
    if (model.closed || model.inUse()) return;
    // Defer so that "close tab + reopen in split" in one tick keeps the model.
    queueMicrotask(async () => {
      if (model.inUse() || model.closed) return;
      const files = this.settings()?.files;
      if (files?.autoSave !== false && model.getMeta().dirty) {
        try {
          await model.save("auto");
        } catch (e) {
          console.warn(`autosave of ${model.path} failed`, e);
        }
      }
      if (model.inUse()) return;
      await model.sync.whenIdle();
      if (model.inUse()) return;
      model.dispose();
      this.byPath.delete(model.path);
      this.byId.delete(model.doc);
      useDocMeta.setState((s) => {
        const next = { ...s };
        delete next[model.path];
        return next;
      }, true);
      useOutline.setState((s) => {
        const next = { ...s };
        delete next[model.path];
        return next;
      }, true);
      _emitEditorEvent({ type: "docClosed", doc: model.doc, path: model.path });
      try {
        await this.backend.close(model.doc);
      } catch (e) {
        console.warn(`doc_close ${model.path} failed`, e);
      }
    });
  }

  applySettings() {
    for (const m of this.byPath.values()) m.applySettings();
  }

  /** Saves every document; failures are notified, and an explicit Save All also rejects with them. */
  async saveAll(reason: "explicit" | "auto") {
    const errors: unknown[] = [];
    await Promise.all(
      [...this.byPath.values()].map((m) =>
        m.save(reason).catch((e) => {
          errors.push(e);
        }),
      ),
    );
    if (errors.length) {
      const e = errors[0];
      this.notify({ level: "error", title: "Could not save", body: e instanceof Error ? e.message : String(e) });
      if (reason === "explicit")
        throw errors.length === 1 ? e : new AggregateError(errors, e instanceof Error ? e.message : String(e));
    }
  }
}
