/** Status bar widgets of the active text editor (design footer). */
import { Fragment, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { basename, dirname, relativePath, useProject } from "@/platform/project";
import type { LineEnding, OutlineItem } from "@/platform/ipc";
import { BarButton, Icon, Menu, badgeKind, fileIconName } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { ENCODING_CHOICES, useEditorPrefs } from "@/platform/editorSettings";
import { isVirtualUri } from "@/platform/virtualDocs";
import { editorController, useEditorStatus, useGotoLine } from "../controller";
import { useDocMeta, useOutline } from "../model/document";
import { symbolChain } from "./outline";
import { NavChildrenPopup } from "./NavBarPopup";
import type { NavSegment } from "./navBar";
import styles from "./EditorArea.module.css";
import { tx } from "@/platform/i18n";

function useActiveMeta() {
  const path = useEditorStatus((s) => s.status?.path ?? null);
  const meta = useDocMeta((s) => (path ? s[path] : undefined));
  return meta;
}

const NO_SYMBOLS: OutlineItem[] = [];

/**
 * Symbols at the caret while `path` is the active editor, `null` otherwise. Selected
 * from the status store so callers re-render when the chain changes, not on every
 * keystroke or caret move.
 */
function useCaretSymbols(path: string | null, outline: readonly OutlineItem[] | undefined) {
  return useEditorStatus(
    useShallow((s) => {
      const st = s.status;
      if (!st || st.path !== path) return null;
      return outline ? symbolChain(outline, st.line, st.col) : NO_SYMBOLS;
    }),
  );
}

interface Crumb {
  label: string;
  icon?: string;
  title: string;
  /** Clicking lists the segment's children (IDEA navigation bar). */
  nav?: NavSegment;
  run?: () => void;
}

/**
 * IDEA new UI navigation bar in the status bar: project › dirs › file ›
 * symbols, with icons; clicking a segment opens a popup of its children.
 */
export function Breadcrumbs() {
  const path = useEditorStatus((s) => s.status?.path ?? null);
  const project = useProject((s) => s.project);
  const outline = useOutline((s) => (path ? s[path] : undefined));
  const chain = useCaretSymbols(path, outline) ?? NO_SYMBOLS;
  const [popup, setPopup] = useState<{ nav: NavSegment; anchor: HTMLElement } | null>(null);
  if (!path) return null;
  const parent = dirname(path);
  const segments: Crumb[] = [];
  if (project)
    segments.push({
      label: project.name,
      icon: "module",
      title: project.root,
      nav: { kind: "dir", path: project.root, label: project.name, root: true },
    });
  if (project && parent !== project.root && parent.startsWith(project.root + "/")) {
    // Every directory from the root to the file, eliding the middle of deep paths.
    const dirs = relativePath(project.root, parent).split("/");
    const shown = dirs.length > 4 ? [...dirs.slice(0, 1), "…", ...dirs.slice(-2)] : dirs;
    let consumed = 0;
    for (const label of shown) {
      if (label === "…") {
        consumed = dirs.length - 2;
        segments.push({
          label,
          title: dirs.join("/"),
          run: () => void executeAction("navigate.selectIn", { path: parent }),
        });
        continue;
      }
      consumed += 1;
      const dir = `${project.root}/${dirs.slice(0, consumed).join("/")}`;
      segments.push({
        label,
        icon: "folder",
        title: relativePath(project.root, dir),
        nav: { kind: "dir", path: dir, label },
      });
    }
  }
  const file = basename(path);
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) || file : file;
  segments.push({
    label: file,
    icon: fileIconName(file),
    title: project ? relativePath(project.root, path) : path,
    nav: { kind: "file", path, label: file },
  });
  for (const item of chain.filter((it, i) => i > 0 || it.name !== stem))
    segments.push({
      label: item.name,
      icon: `symbol-${badgeKind(item.kind)}`,
      title: item.detail ?? item.name,
      nav: { kind: "symbol", path, label: item.name, item },
    });
  return (
    <nav className={styles.status} aria-label={tx("Breadcrumbs")}>
      {segments.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <Icon name="chevron-right" size={12} className={styles.statusSep} />}
          <BarButton
            className={styles.crumbButton}
            tooltip={s.title}
            aria-haspopup={s.nav ? "listbox" : undefined}
            onClick={(e) => {
              const nav = s.nav;
              const anchor = e.currentTarget;
              if (nav) setPopup((p) => (p?.anchor === anchor ? null : { nav, anchor }));
              else s.run?.();
            }}
          >
            {s.icon && <Icon name={s.icon} size={14} className={styles.crumbIcon} />}
            <span className={styles.crumbLabel}>{s.label}</span>
          </BarButton>
        </Fragment>
      ))}
      {popup && <NavChildrenPopup segment={popup.nav} anchor={popup.anchor} onClose={() => setPopup(null)} />}
    </nav>
  );
}

/**
 * Settings › Editor › General › Breadcrumbs: the code structure at the caret
 * (class › method …) above or below the editor of `tabId`.
 */
export function CodeBreadcrumbs({
  path,
  tabId,
  position,
}: {
  path: string;
  tabId: string;
  position: "top" | "bottom";
}) {
  const prefs = useEditorPrefs().breadcrumbs;
  const language = useDocMeta((s) => s[path]?.language);
  const outline = useOutline((s) => s[path]);
  let chain = useCaretSymbols(path, outline);
  if (!chain) {
    // Not the active editor (another split): its own caret, as of this render.
    const caret = editorController().slots.get(tabId)?.caret();
    chain = outline ? symbolChain(outline, caret?.line ?? 0, caret?.col ?? 0) : NO_SYMBOLS;
  }
  if (
    !prefs.show ||
    prefs.placement !== position ||
    (language && prefs.disabledLanguages.includes(language)) ||
    !chain.length
  )
    return null;
  return (
    <nav
      className={clsx(styles.codeCrumbs, position === "top" ? styles.codeCrumbsTop : styles.codeCrumbsBottom)}
      aria-label={tx("Code breadcrumbs")}
    >
      {chain.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <Icon name="chevron-right" size={12} className={styles.statusSep} />}
          <BarButton
            className={styles.crumbButton}
            tooltip={item.detail ?? item.name}
            onClick={() =>
              void editorController().openFile(path, {
                selection: { line: item.selection_range.start.line, col: item.selection_range.start.col },
              })
            }
          >
            <Icon name={`symbol-${badgeKind(item.kind)}`} size={14} className={styles.crumbIcon} />
            <span className={styles.crumbLabel}>{item.name}</span>
          </BarButton>
        </Fragment>
      ))}
    </nav>
  );
}

export function CaretStatus() {
  const status = useEditorStatus((s) => s.status);
  if (!status) return null;
  let text = `${status.line + 1}:${status.col + 1}`;
  if (status.carets > 1) text = `${status.carets} carets`;
  else if (status.selectedChars)
    text += ` (${status.selectedChars} chars${status.selectedLines ? `, ${status.selectedLines} line break${status.selectedLines > 1 ? "s" : ""}` : ""})`;
  return (
    <BarButton
      tooltip="Go to Line:Column"
      shortcut={shortcutLabel("navigate.gotoLine")}
      onClick={() => useGotoLine.setState({ open: true })}
    >
      {text}
    </BarButton>
  );
}

const EOL_LABEL: Record<LineEnding, string> = { lf: "LF", crLf: "CRLF", cr: "CR" };

export function LineEndingStatus() {
  const meta = useActiveMeta();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!meta) return null;
  const choose = (le: LineEnding) => {
    const model = editorController().manager.get(meta.path);
    if (!model || le === meta.lineEnding) return;
    void editorController()
      .manager.backend.setLineEnding(meta.doc, le)
      .then(() => model.setMeta({ lineEnding: le, dirty: true }))
      .catch((e: unknown) =>
        notifications().notify({
          level: "error",
          title: "Cannot change line separators",
          body: e instanceof Error ? e.message : String(e),
        }),
      );
  };
  return (
    <>
      <BarButton
        ref={ref}
        tooltip="Line Separator"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={meta.readOnly}
      >
        {EOL_LABEL[meta.lineEnding]}
      </BarButton>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        placement="top-end"
        aria-label="Line separator"
        items={(["lf", "crLf", "cr"] as LineEnding[]).map((le) => ({
          id: le,
          label: `${EOL_LABEL[le]} – ${le === "lf" ? "Unix and macOS (\\n)" : le === "crLf" ? "Windows (\\r\\n)" : "Classic Mac OS (\\r)"}`,
          checked: meta.lineEnding === le ? true : undefined,
          run: () => choose(le),
        }))}
      />
    </>
  );
}

const ENCODINGS = ENCODING_CHOICES;

/** File encoding widget (IDEA: click → choose an encoding, then Reload or Convert). */
export function EncodingStatus() {
  const meta = useActiveMeta();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!meta) return null;
  const apply = (encoding: string, reload: boolean) => {
    const model = editorController().manager.get(meta.path);
    if (!model) return;
    void editorController()
      .manager.backend.setEncoding(meta.doc, encoding, reload)
      .then((enc) => model.setMeta({ encoding: enc, ...(reload ? {} : { dirty: true }) }))
      .catch((e: unknown) =>
        notifications().notify({
          level: "error",
          title: reload ? "Cannot reload with encoding" : "Cannot convert encoding",
          body: e instanceof Error ? e.message : String(e),
        }),
      );
  };
  const current = meta.encoding.toLowerCase();
  const group = (reload: boolean) =>
    ENCODINGS.filter(([id]) => id !== current).map(([id, label]) => ({
      id: `${reload ? "reload" : "convert"}.${id}`,
      label,
      run: () => apply(id, reload),
    }));
  return (
    <>
      <BarButton
        ref={ref}
        tooltip="File Encoding"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {ENCODINGS.find(([id]) => id === current)?.[1] ?? meta.encoding}
      </BarButton>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        placement="top-end"
        aria-label="File encoding"
        items={[
          { id: "reload", label: "Reload with Encoding", disabled: meta.dirty, submenu: group(true) },
          { id: "convert", label: "Convert to Encoding", disabled: meta.readOnly, submenu: group(false) },
          { kind: "separator" },
          {
            id: "configure",
            label: "File Encodings Settings…",
            run: () => void executeAction("file.settings", "editor.fileEncodings"),
          },
        ]}
      />
    </>
  );
}

/** Indentation widget: per-file override, or open the Code Style settings. */
export function IndentStatus() {
  const meta = useActiveMeta();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!meta) return null;
  const { tabSize, insertSpaces } = meta.indent;
  const label = insertSpaces ? `${tabSize} spaces` : `Tab (${tabSize})`;
  const set = (indent: { tabSize: number; insertSpaces: boolean }) =>
    editorController().manager.get(meta.path)?.setIndent(indent);
  const choice = (id: string, text: string, indent: { tabSize: number; insertSpaces: boolean }) => ({
    id,
    label: text,
    checked: indent.tabSize === tabSize && indent.insertSpaces === insertSpaces ? true : undefined,
    run: () => set(indent),
  });
  return (
    <>
      <BarButton
        ref={ref}
        tooltip="Indentation"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </BarButton>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        placement="top-end"
        aria-label="Indentation"
        items={[
          choice("s2", "2 spaces", { tabSize: 2, insertSpaces: true }),
          choice("s4", "4 spaces", { tabSize: 4, insertSpaces: true }),
          choice("s8", "8 spaces", { tabSize: 8, insertSpaces: true }),
          choice("tab", `Tab (${tabSize})`, { tabSize, insertSpaces: false }),
          { kind: "separator" },
          {
            id: "configure",
            label: "Configure Indents…",
            run: () => void executeAction("file.settings", "editor.codeStyle"),
          },
        ]}
      />
    </>
  );
}

/** IDEA's read-only attribute widget: the lock toggles the file's writable bit (asking first). */
export function ReadOnlyStatus() {
  const meta = useActiveMeta();
  if (!meta || isVirtualUri(meta.path) || meta.banner === "binary" || meta.banner === "tooLarge") return null;
  const label = meta.readOnly ? "Make file writable" : "Make file read-only";
  return (
    <BarButton
      tooltip={label}
      aria-label={label}
      aria-pressed={meta.readOnly}
      onClick={() => void executeAction("file.toggleReadOnly")}
    >
      <span className={styles.lock}>
        <Icon name={meta.readOnly ? "lock" : "unlock"} size={14} />
      </span>
    </BarButton>
  );
}
