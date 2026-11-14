/**
 * The message box of the New Task page and of sessions: `@` file and folder references
 * (project index search) shown as chips, `/` agent commands, `>` quotes as blocks, ↑ / ↓
 * history, pasted or dropped images, files dropped from outside the project as attachments,
 * pasted project paths as references, Shift+Tab to cycle the agent's mode. Its draft lives
 * in the store under `id`; the text there is what's sent (see `composerEditor`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { VirtualElement } from "@floating-ui/react-dom";
import { history, historyKeymap, insertNewline, standardKeymap } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText, type ViewUpdate } from "@codemirror/view";
import type { AgentCommand, AgentConfigOption, AgentImage, SendKey, SymbolMatch, WhileRunning } from "@/bindings";
import { useEditorRegistry, openEditorPaths } from "@/editor/api";
import { call, commands, isTauri } from "@/platform/ipc";
import { nativeDropPoint } from "@/platform/nativeDrop";
import { invokeLocal } from "@/platform/tauriCore";
import { useTx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { registerKeyClaim } from "@/platform/keymap";
import { isVirtualUri } from "@/platform/virtualDocs";
import { copySourceOf } from "@/platform/clipboardSource";
import {
  getAgentContextSources,
  notifications,
  OWNS_FILE_DROP,
  type AgentContextSource,
} from "@/workbench/contributions";
import {
  FILES_DRAG,
  Icon,
  IconButton,
  List,
  Popup,
  firstSelectable,
  listNavigate,
  fileIconName,
  registerDropTarget,
} from "@/ui";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  applyCompletion,
  atEdgeLine,
  isMentioned,
  isPathQuery,
  mergeMatches,
  resolveTyped,
  completionAt,
  fenced,
  LONG_PASTE_LINES,
  looksLikeTrace,
  pastedPaths,
  placesInText,
  imageFromDataUrl,
  matchCommands,
  mentionOf,
  modeOption,
  nextValue,
  recall,
  toPrompt,
  type Completion,
  type FileRef,
} from "./composerModel";
import { referenceExtensions, setReferences } from "./composerEditor";
import { referenceHover } from "./ReferenceChip";
import { composerDraft, updateComposer, useAgents } from "./store";
import { ImagePreview, imageSrc } from "./ImagePreview";
import { useAgentSettings } from "./agentSettings";
import styles from "./Composer.module.css";
import { isImeKey } from "@/platform/ime";

const MAX_ITEMS = 12;
const MAX_OPEN_EDITORS = 5;

type Section = "command" | "skill" | "open" | "project" | "context" | "files";

type Item =
  | {
      kind: "file";
      path: string;
      rel: string;
      dir?: boolean;
      indices?: readonly number[];
    }
  | { kind: "command"; command: AgentCommand }
  | { kind: "context"; source: AgentContextSource }
  | { kind: "symbol"; symbol: SymbolMatch; path: string }
  | { kind: "section"; source: Section };

const isSection = (item: Item) => item.kind === "section";

const SECTION_TITLES: Record<Section, string> = {
  command: "Commands",
  skill: "Skills",
  open: "Open Editors",
  project: "Project",
  context: "Context",
  files: "Files",
};

/** A change the store made (a quote, a reference sent from the editor): not written back. */
const fromStore = Annotation.define<boolean>();

/** `abs` relative to the first of `bases` it is under ("." for the base itself). */
function relativeTo(bases: readonly string[], abs: string): string | null {
  const source = resolveTyped("", abs.replace(/\\/g, "/"));
  const base = bases
    .filter(Boolean)
    .map((path) => resolveTyped(path, "."))
    .find((path) => source === path || source.startsWith(`${path}/`));
  if (!base) return null;
  return source === base ? "." : source.slice(base.length + 1);
}

export interface ComposerProps {
  /** Store key of the draft. */
  id: string;
  placeholder: string;
  /** Directory `@` references resolve in (the task's worktree, or the project root). */
  root: string;
  /** The project root the file index covers. */
  projectRoot: string;
  commands: readonly AgentCommand[];
  /** Sent messages, newest first. */
  history: readonly string[];
  /** Settings; Shift+Tab cycles the mode one. */
  config: readonly AgentConfigOption[];
  onConfig?: (option: string, value: string) => void;
  /** `now`: send even while the agent works, into its turn (by default ⌘↵). */
  onSubmit: (now: boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Left of the bottom row: agent / model / mode pickers. */
  toolbar?: ReactNode;
  /** Right of the bottom row: send / stop buttons. */
  actions?: ReactNode;
  className?: string;
}

/**
 * What a key press in the composer sends: "queue" waits for the turn to end, "now" goes into
 * it. The send key sends the way Settings › Agents › Chat says, with Shift (or the
 * modifier, when Enter sends) the other way; without the send key, Enter is a new line.
 */
export function sendKeyAction(
  e: {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey?: boolean;
  },
  sendWith: SendKey,
  whileRunning: WhileRunning,
): "queue" | "now" | null {
  if (e.key !== "Enter" || e.altKey) return null;
  const mod = e.metaKey || e.ctrlKey;
  let other: boolean;
  if (sendWith === "enter") {
    if (e.shiftKey) return null;
    other = mod;
  } else {
    if (!mod) return null;
    other = e.shiftKey;
  }
  return (whileRunning === "steer") !== other ? "now" : "queue";
}

/** Highlights the matched characters of `text` (`indices` counted from `offset`). */
function Matched({ text, indices, offset = 0 }: { text: string; indices?: readonly number[]; offset?: number }) {
  if (!indices?.length) return <>{text}</>;
  const marked = new Set(indices.map((i) => i - offset));
  const out: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    out.push(
      runMarked ? (
        <mark key={key} className={styles.match}>
          {run}
        </mark>
      ) : (
        run
      ),
    );
    run = "";
  };
  [...text].forEach((ch, i) => {
    const m = marked.has(i);
    if (m !== runMarked) flush(i);
    runMarked = m;
    run += ch;
  });
  flush(text.length);
  return <>{out}</>;
}

export function Composer(props: ComposerProps) {
  const { id, root, projectRoot } = props;
  const tx = useTx();
  const draft = useAgents((s) => s.composers.get(id));
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const draftFiles = draft?.files;
  const attached = useMemo(() => draftFiles?.filter((f) => f.attached) ?? [], [draftFiles]);
  const [preview, setPreview] = useState<AgentImage | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The same view, for rendering (the completion popup's anchor).
  const [shownView, setShownView] = useState<EditorView | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const placeholderSlot = useRef(new Compartment());
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [files, setFiles] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const recalled = useRef<{ index: number; stash: string }>({
    index: -1,
    stash: "",
  });
  const { sendWith, whileRunning } = useAgentSettings();

  /** Replaces `from`–`to` with `insert` and puts the caret at `caret` (after the insert by default). */
  const replace = useCallback((from: number, to: number, insert: string, caret = from + insert.length) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: caret },
      userEvent: "input.complete",
    });
    view.focus();
  }, []);
  const setText = (value: string, caret = value.length) => {
    const view = viewRef.current;
    if (view) replace(0, view.state.doc.length, value, caret);
  };

  // Late-bound handlers: the editor is created once per draft, the props change every render.
  const onKeyDownRef = useRef<(e: KeyboardEvent, view: EditorView) => boolean>(() => false);
  const onPasteRef = useRef<(e: ClipboardEvent, view: EditorView) => boolean>(() => false);
  const onUpdateRef = useRef<(u: ViewUpdate) => void>(() => {});

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: composerDraft(id).text,
        extensions: [
          history(),
          EditorView.lineWrapping,
          placeholderSlot.current.of([]),
          EditorView.contentAttributes.of({
            "aria-multiline": "true",
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
          }),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e, v) => onKeyDownRef.current(e, v),
              paste: (e, v) => onPasteRef.current(e, v),
            }),
          ),
          referenceExtensions(),
          keymap.of([
            { key: "Enter", run: insertNewline, shift: insertNewline },
            { key: "Mod-Enter", run: insertNewline },
          ]),
          keymap.of([...standardKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => onUpdateRef.current(u)),
        ],
      }),
    });
    view.dispatch({ effects: setReferences.of(composerDraft(id).files) });
    viewRef.current = view;
    setShownView(view);
    recalled.current = { index: -1, stash: "" };
    const disposeHover = referenceHover(host);
    return () => {
      disposeHover();
      viewRef.current = null;
      setShownView(null);
      view.destroy();
    };
  }, [id]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: placeholderSlot.current.reconfigure(placeholderText(tx(props.placeholder))),
    });
  }, [props.placeholder, tx, id]);

  useLayoutEffect(() => {
    viewRef.current?.contentDOM.setAttribute("aria-label", tx("Message"));
  }, [tx, id]);

  // The store's text changed elsewhere (a quote, Send to Agent, a restored message).
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === text) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      annotations: fromStore.of(true),
    });
  }, [text, id]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: setReferences.of(draftFiles ?? []) });
  }, [draftFiles, id]);

  const onUpdate = (u: ViewUpdate) => {
    if (u.docChanged && !u.transactions.some((t) => t.annotation(fromStore))) {
      updateComposer(id, { text: u.state.doc.toString() });
    }
    if (u.focusChanged && !u.view.hasFocus) {
      setCompletion(null);
      return;
    }
    if (u.docChanged || u.selectionSet) {
      const composing = u.view.composing || u.view.compositionStarted;
      setCompletion(composing ? null : completionAt(u.state.doc.toString(), u.state.selection.main.head));
      if (u.docChanged) setActive(0);
    }
  };

  useEffect(() => {
    if (props.autoFocus) viewRef.current?.focus();
  }, [props.autoFocus, id]);

  const focus = useAgents((s) => (s.focus?.key === id ? s.focus.seq : 0));
  useEffect(() => {
    const view = viewRef.current;
    if (!focus || !view) return;
    view.focus();
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    });
  }, [focus]);

  // `@` completion: project file search, mapped into the task's directory.
  useEffect(() => {
    if (completion?.kind !== "file") return;
    let alive = true;
    const query = completion.query;
    const timer = setTimeout(() => {
      if (query.startsWith("#")) {
        // `@#name`: a symbol, referenced by its file and line.
        call(commands.findSymbols(query.slice(1), "all", MAX_ITEMS))
          .then((found) => {
            if (!alive) return;
            setFiles(
              found.map((symbol) => ({
                kind: "symbol",
                symbol,
                path: root === projectRoot ? symbol.path : `${root}/${symbol.relPath}`,
              })),
            );
          })
          .catch(() => alive && setFiles([]));
        return;
      }
      if (isPathQuery(query)) {
        // Outside the index: list the directory typed so far.
        const typed = /(^|\/)\.\.?$/.test(query) ? `${query}/` : query;
        const dirPart = typed.slice(0, typed.lastIndexOf("/") + 1);
        const last = typed.slice(dirPart.length);
        call(commands.pathCompletions(`${typed.startsWith("/") ? "" : root}/_`, typed))
          .then((found) => {
            if (!alive) return;
            setFiles(
              found
                .filter((f) => f.name.toLowerCase().startsWith(last.toLowerCase()))
                .slice(0, MAX_ITEMS)
                .map((f) => {
                  const rel = `${dirPart}${f.name}`;
                  return {
                    kind: "file",
                    rel,
                    dir: f.dir,
                    path: resolveTyped(root, rel),
                  };
                }),
            );
          })
          .catch(() => alive && setFiles([]));
        return;
      }
      Promise.all([call(commands.findFiles(query, MAX_ITEMS)), call(commands.findDirs(query, MAX_ITEMS))])
        .then(async ([found, dirs]) => {
          if (!alive) return;
          // A bare `@`: the files open in editors, then the root (the index has nothing to
          // match on).
          if (!query && found.length + dirs.length === 0) {
            const open: Item[] = [];
            for (const path of openEditorPaths()) {
              const rel = isVirtualUri(path) ? null : relativeTo([projectRoot, root], path);
              if (!rel || rel === "." || open.some((o) => o.kind === "file" && o.rel === rel)) continue;
              open.push({ kind: "file", rel, path: resolveTyped(root, rel) });
              if (open.length >= MAX_OPEN_EDITORS) break;
            }
            const top = await call(commands.pathCompletions(`${root}/_`, "")).catch(() => []);
            if (!alive) return;
            const listed: Item[] = top.slice(0, MAX_ITEMS).map((f) => ({
              kind: "file",
              rel: f.name,
              dir: f.dir,
              path: resolveTyped(root, f.name),
            }));
            setFiles(
              open.length
                ? [{ kind: "section", source: "open" }, ...open, { kind: "section", source: "project" }, ...listed]
                : listed,
            );
            return;
          }
          setFiles(
            mergeMatches(found, dirs, MAX_ITEMS).map((f) => ({
              kind: "file",
              rel: f.rel,
              dir: f.dir,
              indices: f.indices,
              path: root === projectRoot ? f.path : `${root}/${f.rel}`,
            })),
          );
        })
        .catch(() => alive && setFiles([]));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [completion?.kind, completion?.query, root, projectRoot]);

  const items: Item[] = useMemo(() => {
    if (!completion) return [];
    if (completion.kind === "file") {
      const q = completion.query.toLowerCase();
      if (q.startsWith("#") || isPathQuery(q)) return files;
      // `@problems`, `@terminal`, `@changes`…: what features offer, above the files.
      const sources = getAgentContextSources().filter((s) => s.id.startsWith(q));
      if (!sources.length) return files;
      const rest: Item[] =
        files[0]?.kind === "section" || !files.length ? files : [{ kind: "section", source: "files" }, ...files];
      return [
        { kind: "section", source: "context" },
        ...sources.map((source) => ({ kind: "context" as const, source })),
        ...rest,
      ];
    }
    const out: Item[] = [];
    let source: "command" | "skill" | undefined;
    for (const command of matchCommands(props.commands, completion.query)) {
      const next = command.source ?? "command";
      if (source !== next) {
        source = next;
        out.push({ kind: "section", source });
      }
      out.push({ kind: "command", command });
    }
    return out;
  }, [completion, files, props.commands]);
  const activeIndex = items[active] && !isSection(items[active]!) ? active : firstSelectable(items, isSection);
  const open = !!completion && items.some((item) => !isSection(item));
  const anchorAt = open ? completion.to : null;
  const completionAnchor = useMemo<VirtualElement | null>(() => {
    const view = shownView;
    if (anchorAt === null || !view) return null;
    return {
      contextElement: view.dom,
      getBoundingClientRect: () => {
        const at = view.coordsAtPos(Math.min(anchorAt, view.state.doc.length));
        if (!at) return view.contentDOM.getBoundingClientRect();
        return new DOMRect(at.left, at.top, 0, at.bottom - at.top);
      },
    };
  }, [anchorAt, shownView]);

  /** Enter or a click references the item; Tab on a folder keeps completing inside it. */
  const accept = (item: Item | undefined, descend = false) => {
    if (!item || item.kind === "section" || !completion) return;
    const current = viewRef.current?.state.doc.toString() ?? text;
    if (item.kind === "context") {
      const view = viewRef.current;
      const at = completion;
      setCompletion(null);
      if (!view) return;
      void item.source.resolve().then(
        (context) => {
          if (!context) {
            replace(at.from, at.to, "");
            notifications().notify({
              level: "info",
              title: tx(item.source.title),
              body: tx("Nothing to add right now"),
            });
          } else if (context.kind === "block") {
            insertBlock(view, at.from, at.to, context.info, context.text);
          } else {
            const refs = context.paths.flatMap((path) => {
              const rel = relativeTo([root, projectRoot], path);
              return rel && rel !== "." && !/\s/.test(rel) ? [{ path: resolveTyped(root, rel), rel }] : [];
            });
            const known = new Set(composerDraft(id).files.map((f) => f.path));
            updateComposer(id, { files: [...composerDraft(id).files, ...refs.filter((r) => !known.has(r.path))] });
            replace(at.from, at.to, refs.length ? `${refs.map((r) => mentionOf(r.rel)).join(" ")} ` : "");
          }
        },
        (error: unknown) =>
          notifications().notify({ level: "error", title: tx(item.source.title), body: String(error) }),
      );
      return;
    }
    if (item.kind === "symbol") {
      const rel = item.symbol.relPath;
      const line = item.symbol.range.start.line + 1;
      updateComposer(id, { files: [...composerDraft(id).files, { path: item.path, rel } satisfies FileRef] });
      const next = applyCompletion(current, completion, mentionOf(rel, { from: line, to: line }));
      setText(next.text, next.caret);
      setCompletion(null);
      return;
    }
    if (item.kind === "file") {
      const rel = item.dir ? `${item.rel}/` : item.rel;
      // A folder stays referenced while its `@folder/` is left as typed (`toPrompt`).
      updateComposer(id, {
        files: [...composerDraft(id).files, { path: item.path, rel } satisfies FileRef],
      });
      if (item.dir && descend) {
        replace(completion.from, completion.to, mentionOf(rel));
        return;
      }
      const next = applyCompletion(current, completion, mentionOf(rel));
      setText(next.text, next.caret);
    } else {
      const next = applyCompletion(current, completion, `/${item.command.name}`);
      setText(next.text, next.caret);
    }
    setCompletion(null);
  };

  const [fileOver, setFileOver] = useState(false);

  /**
   * Adds paths as `@` references (a file or a folder), each once. A path outside the project is
   * attached when `attachOutside` (an OS drop in a local window), else skipped.
   */
  const addPaths = useCallback(
    (paths: readonly string[], attachOutside = false) => {
      const current = composerDraft(id);
      const known = new Set(toPrompt(current).files);
      const files = current.files.filter((f) => known.has(f.path));
      const refs: FileRef[] = [];
      for (const raw of paths) {
        if (!/^(\/|[A-Za-z]:[\\/])/.test(raw)) continue;
        const rel = relativeTo([root, projectRoot], raw);
        if (rel === null) {
          if (!attachOutside || isRemoteWindow() || known.has(raw)) continue;
          known.add(raw);
          refs.push({
            path: raw,
            rel: basename(resolveTyped("", raw.replace(/\\/g, "/"))),
            attached: true,
          });
          continue;
        }
        const path = resolveTyped(root, rel);
        if (known.has(path)) continue;
        known.add(path);
        refs.push({ path, rel });
      }
      if (!refs.length) return;
      const mentions = refs.flatMap((r) => (r.attached ? [] : [mentionOf(r.rel)])).join(" ");
      const glue = current.text && !/\s$/.test(current.text) ? " " : "";
      const text = mentions ? `${current.text}${glue}${mentions} ` : current.text;
      updateComposer(id, { text, files: [...files, ...refs] });
    },
    [id, root, projectRoot],
  );

  const addImages = useCallback(
    (list: AgentImage[]) => {
      if (list.length) updateComposer(id, { images: [...composerDraft(id).images, ...list] });
    },
    [id],
  );

  const fitsLimit = (name: string, size: number) => {
    if (size <= MAX_IMAGE_BYTES) return true;
    notifications().notify({
      level: "warning",
      title: "Image too large",
      body: tx`${name} is over 5 MB.`,
    });
    return false;
  };

  const readImageFiles = (picked: Iterable<File>) => {
    for (const file of picked) {
      if (!file.type.startsWith("image/") || !fitsLimit(file.name, file.size)) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const image = typeof reader.result === "string" ? imageFromDataUrl(reader.result, file.name || "image") : null;
        if (image) addImages([image]);
      };
      reader.readAsDataURL(file);
    }
  };

  const pasteClipboardImage = async () => {
    const url = await call(commands.clipboardImage());
    const image = url ? imageFromDataUrl(url, "image") : null;
    if (image && fitsLimit("image", (image.data.length * 3) / 4)) addImages([image]);
  };

  /**
   * Pasted paths of project files or folders (one per line, with `:10-20` lines, quoted or
   * `file://`) go in as references when they all exist; anything else is pasted as text.
   */
  const pastePath = (pasted: string, view: EditorView): boolean => {
    const paths = pastedPaths(pasted);
    const found = paths?.map((p) => ({ ...p, rel: relativeTo([root, projectRoot], p.path) }));
    // A mention ends at whitespace: a path with a space stays text.
    if (!found || found.some((p) => !p.rel || p.rel === "." || /\s/.test(p.rel))) return false;
    const { from, to } = view.state.selection.main;
    void Promise.all(
      found.map(async (p) => {
        const path = resolveTyped(root, p.rel!);
        const kind = await call(commands.fsEntryKind(path));
        const dir = kind === "dir";
        return { path, rel: dir ? `${p.rel}/` : p.rel!, lines: dir ? undefined : p.lines };
      }),
    ).then(
      (refs) => {
        const known = new Set(composerDraft(id).files.map((f) => f.path));
        const added = refs.filter((r) => !known.has(r.path)).map(({ path, rel }) => ({ path, rel }) satisfies FileRef);
        updateComposer(id, { files: [...composerDraft(id).files, ...added] });
        const before = view.state.sliceDoc(Math.max(0, from - 1), from);
        const glue = before && !/\s/.test(before) ? " " : "";
        replace(from, to, `${glue}${refs.map((r) => mentionOf(r.rel, r.lines)).join(" ")} `);
      },
      () => replace(from, to, pasted),
    );
    return true;
  };

  /** The project files `text` names at a line, as `@rel:line` (existing files only). */
  const projectPlaces = async (text: string): Promise<string[]> => {
    const found = await Promise.all(
      placesInText(text).map(async ({ path, line }) => {
        const absolute = /^(\/|[A-Za-z]:[\\/])/.test(path);
        const rel = relativeTo([root, projectRoot], absolute ? path : resolveTyped(root, path.replace(/^\.\//, "")));
        if (!rel || rel === "." || /\s/.test(rel)) return null;
        const kind = await call(commands.fsEntryKind(resolveTyped(root, rel))).catch(() => null);
        return kind === "file" ? { rel, line } : null;
      }),
    );
    const refs = found.filter((r) => r !== null);
    if (refs.length) {
      const known = new Set(composerDraft(id).files.map((f) => f.rel));
      const added = [...new Set(refs.map((r) => r.rel))]
        .filter((rel) => !known.has(rel))
        .map((rel) => ({ path: resolveTyped(root, rel), rel }) satisfies FileRef);
      updateComposer(id, { files: [...composerDraft(id).files, ...added] });
    }
    return refs.map((r) => mentionOf(r.rel, { from: r.line, to: r.line }));
  };

  /**
   * `text` as a ``` block on its own lines in place of `from`–`to`; the project files it names
   * at a line follow it as references once they are found.
   */
  const insertBlock = (view: EditorView, start: number, to: number, info: string, text: string) => {
    // The spaces before it on its line go: the block starts a line of its own.
    const lineStart = view.state.doc.lineAt(start).from;
    const from = lineStart + view.state.sliceDoc(lineStart, start).replace(/[ \t]+$/, "").length;
    const before = view.state.sliceDoc(Math.max(0, from - 1), from);
    const insert = `${before && before !== "\n" ? "\n" : ""}${fenced(text, info)}\n`;
    replace(from, to, insert);
    const end = from + insert.length;
    const doc = view.state.doc;
    void projectPlaces(text).then((mentions) => {
      if (!mentions.length) return;
      // Right after the block, unless the text changed meanwhile: then at the end.
      const at = view.state.doc === doc ? end : view.state.doc.length;
      replace(at, at, `${mentions.join(" ")} `);
    });
  };

  /** A stack trace, or text too long to read in the box, goes in as a block. */
  const pasteLong = (pasted: string, view: EditorView): boolean => {
    const trace = looksLikeTrace(pasted);
    if (!trace && pasted.split("\n").length < LONG_PASTE_LINES) return false;
    const { from, to } = view.state.selection.main;
    insertBlock(view, from, to, trace ? "trace" : "text", pasted);
    return true;
  };

  /**
   * Text copied in the IDE: an editor's lines become a reference to them (a ``` block when the
   * file is outside the project), a terminal's output a terminal block. A single line from an
   * editor is pasted as text.
   */
  const pasteCopied = (pasted: string, view: EditorView): boolean => {
    const source = copySourceOf(pasted);
    if (!source) return false;
    const { from, to } = view.state.selection.main;
    const block = (info: string) => insertBlock(view, from, to, info, pasted);
    if (source.kind === "terminal") {
      block(`terminal ${source.title}`.trim());
      return true;
    }
    if (!pasted.replace(/\s+$/, "").includes("\n")) return false;
    const rel = relativeTo([root, projectRoot], source.path);
    if (!rel || rel === ".") {
      const ext = /\.([\w+-]+)$/.exec(source.path)?.[1] ?? "";
      block(ext);
      return true;
    }
    updateComposer(id, { files: [...composerDraft(id).files, { path: resolveTyped(root, rel), rel }] });
    const before = view.state.sliceDoc(Math.max(0, from - 1), from);
    const glue = before && !/\s/.test(before) ? " " : "";
    replace(from, to, `${glue}${mentionOf(rel, { from: source.from, to: source.to })} `);
    return true;
  };

  const onPaste = (e: ClipboardEvent, view: EditorView): boolean => {
    const data = e.clipboardData;
    if (!data) return false;
    const pasted = [...data.files].filter((f) => f.type.startsWith("image/"));
    if (pasted.length) {
      e.preventDefault();
      readImageFiles(pasted);
      return true;
    }
    if (isTauri() && !data.types.length) {
      // CodeMirror would otherwise paste empty text over the selection.
      e.preventDefault();
      pasteClipboardImage().catch((error: unknown) =>
        notifications().notify({
          level: "error",
          title: tx("Cannot insert image"),
          body: String(error),
        }),
      );
      return true;
    }
    const plain = data.getData("text/plain");
    if (plain && pasteCopied(plain, view)) {
      e.preventDefault();
      return true;
    }
    if (plain && (pastePath(plain, view) || pasteLong(plain, view))) {
      e.preventDefault();
      return true;
    }
    return false;
  };

  // Files dropped from the OS onto the box: images are inlined when they can be, other files
  // referenced, or attached by path when outside the project.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const inBox = (position: { x: number; y: number }) => {
      const box = boxRef.current?.getBoundingClientRect();
      const { x, y } = nativeDropPoint(position);
      return !!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            setFileOver(inBox(p.position));
            return;
          }
          setFileOver(false);
          if (p.type !== "drop" || !p.paths.length || !inBox(p.position)) return;
          const paths: string[] = [];
          for (const path of p.paths) {
            if (IMAGE_EXTENSIONS.test(path)) {
              void invokeLocal<string>("fs_read_image", { path }).then(
                (url) => {
                  const image = imageFromDataUrl(url, basename(path));
                  if (image && (image.data.length * 3) / 4 <= MAX_IMAGE_BYTES) addImages([image]);
                  else addPaths([path], true);
                },
                () => addPaths([path], true),
              );
            } else {
              paths.push(path);
            }
          }
          addPaths(paths, true);
        })
        .then((u) => {
          if (disposed) u();
          else unlisten = u;
        }),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPaths, addImages]);

  // Files and folders dragged from the Project view: the same `@` references.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    return registerDropTarget(el, {
      accepts: (type) => type === FILES_DRAG,
      over: () => setFileOver(true),
      leave: () => setFileOver(false),
      drop: (data) => {
        setFileOver(false);
        addPaths(data.payload.split("\n").filter(Boolean));
      },
    });
  }, [addPaths]);

  // The editor is a text field to the IDE keymap: plain keys type here, shortcuts stay global;
  // the completion keeps Escape.
  useEffect(
    () =>
      registerKeyClaim((e, stroke) => {
        const box = boxRef.current;
        const target = e.target as Element | null;
        if (!box || !target?.closest || !box.contains(target) || !target.closest(".cm-content")) return false;
        if (stroke === "Escape" && box.hasAttribute("data-completing")) return true;
        if ((e.key === "Backspace" || e.key === "Delete") && !e.shiftKey) return true;
        return !(e.metaKey || e.ctrlKey || e.altKey) && !/^(Shift\+)?(F\d{1,2}|Escape)$/.test(stroke);
      }),
    [],
  );

  const onKeyDown = (e: KeyboardEvent, view: EditorView): boolean => {
    // The input method's (the editor leaves them alone too).
    if (view.composing || isImeKey(e)) return false;
    const handled = () => {
      e.preventDefault();
      return true;
    };
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const next = listNavigate(e.key, {
          items,
          active: activeIndex,
          isSection,
          wrap: true,
        });
        if (next !== null) setActive(next);
        return handled();
      }
      if (e.key === "Enter" || e.key === "Tab") {
        accept(items[activeIndex], e.key === "Tab");
        return handled();
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setCompletion(null);
        return handled();
      }
    }
    const send = sendKeyAction(e, sendWith, whileRunning);
    if (send) {
      if (!props.disabled) props.onSubmit(send === "now");
      recalled.current = { index: -1, stash: "" };
      return handled();
    }
    if (e.key === "Tab" && e.shiftKey) {
      const mode = modeOption(props.config);
      const value = mode && nextValue(mode);
      if (mode && value && props.onConfig) {
        props.onConfig(mode.id, value);
        return handled();
      }
      return false;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.metaKey && !e.shiftKey) {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const current = view.state.doc.toString();
      const r = recalled.current;
      // Only from an empty box or one showing a recalled message, with the caret on the edge line.
      const fresh = r.index === -1 ? current === "" : current === props.history[r.index];
      if (!fresh || !atEdgeLine(current, view.state.selection.main.head, dir)) return false;
      const next = recall(props.history, r.index, dir);
      if (next === null) return false;
      if (r.index === -1) r.stash = current;
      r.index = next;
      const value = next === -1 ? r.stash : props.history[next]!;
      setText(value);
      setCompletion(null);
      return handled();
    }
    return false;
  };

  useLayoutEffect(() => {
    onUpdateRef.current = onUpdate;
    onPasteRef.current = onPaste;
    onKeyDownRef.current = onKeyDown;
  });

  // The file in the focused editor, offered as a reference until the draft has it.
  const activePath = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const suggested = useMemo(() => {
    if (!activePath || isVirtualUri(activePath)) return null;
    const rel = relativeTo([projectRoot, root], activePath);
    if (!rel || rel === "." || isMentioned(text, rel)) return null;
    return { path: activePath, rel };
  }, [activePath, projectRoot, root, text]);

  const showContext = images.length > 0 || attached.length > 0 || !!suggested;

  return (
    <div
      ref={boxRef}
      className={clsx(styles.composer, fileOver && styles.fileOver, props.className)}
      data-completing={open ? "" : undefined}
      {...OWNS_FILE_DROP}
      onMouseDown={(e) => {
        // The padding around the text focuses it too.
        const view = viewRef.current;
        if (view && !view.dom.contains(e.target as Node) && !(e.target as Element).closest("button, input")) {
          e.preventDefault();
          view.focus();
        }
      }}
    >
      {open && completionAnchor && (
        <Popup
          open
          anchor={completionAnchor}
          placement="bottom-start"
          autoFocus={false}
          restoreFocus={false}
          closeOnOutsideClick={false}
          onClose={() => setCompletion(null)}
          className={styles.popup}
          role="presentation"
        >
          <List
            items={items}
            getKey={(item) =>
              item.kind === "section"
                ? `section:${item.source}`
                : item.kind === "file"
                  ? item.path
                  : item.kind === "context"
                    ? `context:${item.source.id}`
                    : item.kind === "symbol"
                      ? `symbol:${item.path}:${item.symbol.range.start.line}:${item.symbol.name}`
                      : `${item.command.source ?? "command"}:${item.command.name}`
            }
            isSection={isSection}
            renderSection={(item) => item.kind === "section" && tx(SECTION_TITLES[item.source])}
            activeIndex={activeIndex}
            onActiveChange={setActive}
            onActivate={(item) => accept(item)}
            focusable={false}
            hoverSelects
            aria-label={tx(completion.kind === "file" ? "Files" : "Commands")}
            className={styles.items}
            renderItem={(item) => {
              if (item.kind === "section") return null;
              if (item.kind === "context")
                return (
                  <>
                    <Icon name={item.source.icon} size={16} />
                    <span className={styles.itemName}>@{item.source.id}</span>
                    <span className={styles.itemDetail}>{tx(item.source.description)}</span>
                  </>
                );
              if (item.kind === "symbol")
                return (
                  <>
                    <Icon name={`symbol-${item.symbol.kind}`} size={16} />
                    <span className={styles.itemName}>
                      <Matched text={item.symbol.name} indices={item.symbol.indices} />
                    </span>
                    <span className={styles.itemDetail}>
                      {item.symbol.container ? `${item.symbol.container} · ` : ""}
                      {item.symbol.relPath}:{item.symbol.range.start.line + 1}
                    </span>
                  </>
                );
              if (item.kind === "command")
                return (
                  <>
                    <span className={styles.itemName}>/{item.command.name}</span>
                    {item.command.hint && <span className={styles.itemHint}>{item.command.hint}</span>}
                    <span className={styles.itemDetail}>{item.command.description}</span>
                  </>
                );
              const name = basename(item.rel);
              const dir = item.rel.slice(0, item.rel.length - name.length).replace(/\/$/, "");
              return (
                <>
                  <Icon name={item.dir ? "folder" : fileIconName(name, item.rel)} size={16} />
                  <span className={styles.itemName}>
                    <Matched text={name} indices={item.indices} offset={item.rel.length - name.length} />
                    {item.dir && "/"}
                  </span>
                  <span className={styles.itemDetail}>{dir}</span>
                </>
              );
            }}
          />
          <div className={styles.popupFooter} aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> {tx("Navigate")}
            </span>
            <span>
              <kbd>↵</kbd> {tx(completion.kind === "file" ? "Reference" : "Insert")}
            </span>
            {completion.kind === "file" && items.some((i) => i.kind === "file" && i.dir) && (
              <span>
                <kbd>⇥</kbd> {tx("Enter Folder")}
              </span>
            )}
            <span>
              <kbd>esc</kbd> {tx("Close")}
            </span>
          </div>
        </Popup>
      )}
      {fileOver && (
        <div className={styles.dropOverlay} aria-hidden="true">
          <Icon name="paperclip" size={16} />
          {tx("Drop to reference")}
        </div>
      )}
      {showContext && (
        <div className={styles.context} onMouseDown={(e) => e.stopPropagation()}>
          {suggested && (
            <button
              type="button"
              className={styles.suggestion}
              title={tx`Reference ${suggested.rel}`}
              onClick={() => addPaths([suggested.path])}
            >
              <Icon name="plus" size={12} />
              <Icon name={fileIconName(basename(suggested.rel), suggested.rel)} size={14} />
              <span className={styles.attachmentName}>{basename(suggested.rel)}</span>
              <span className={styles.suggestionHint}>{tx("Current File")}</span>
            </button>
          )}
          {attached.map((file) => (
            <span key={file.path} className={styles.attachment} title={file.path}>
              <Icon name={fileIconName(file.rel, file.path)} size={14} />
              <span className={styles.attachmentName}>{file.rel}</span>
              <button
                type="button"
                className={styles.removeChip}
                aria-label={tx("Remove File")}
                onClick={() =>
                  updateComposer(id, {
                    files: composerDraft(id).files.filter((f) => f.path !== file.path),
                  })
                }
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          {images.map((img, i) => (
            <span key={i} className={styles.image} title={img.name ?? undefined}>
              <button type="button" className={styles.previewImage} onClick={() => setPreview(img)}>
                <img src={imageSrc(img)} alt={img.name ?? tx("Image")} />
              </button>
              <button
                type="button"
                className={styles.removeImage}
                aria-label={tx("Remove Image")}
                onClick={() =>
                  updateComposer(id, {
                    images: images.filter((_, j) => j !== i),
                  })
                }
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          <ImagePreview image={preview} onClose={() => setPreview(null)} />
        </div>
      )}
      <div ref={hostRef} className={styles.field} />
      <div className={styles.bar} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.toolbar}>{props.toolbar}</div>
        <div className={styles.actions}>
          <IconButton
            icon="paperclip"
            title="Reference a File (@)"
            className={styles.composerButton}
            onClick={() => {
              const view = viewRef.current;
              if (!view) return;
              // At the caret while typing, else after the text.
              const end = view.state.doc.length;
              const { from, to } = view.hasFocus ? view.state.selection.main : { from: end, to: end };
              const before = view.state.sliceDoc(Math.max(0, from - 1), from);
              replace(from, to, before && !/\s/.test(before) ? " @" : "@");
            }}
          />
          <IconButton
            icon="image"
            title="Attach Image…"
            className={styles.composerButton}
            onClick={() => imageInput.current?.click()}
          />
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              readImageFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
          <span className={styles.spacer} />
          {props.actions}
        </div>
      </div>
    </div>
  );
}
