/** Status bar widgets of the active text editor (design footer). */
import { Fragment, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { basename, dirname, projectFolder, relativePath, useProject } from "@/platform/project";
import type { LineEnding, OutlineItem } from "@/platform/ipc";
import { BarButton, Icon, Menu, badgeKind, fileIconName } from "@/ui";
import { notifications, useProjectViewLead } from "@/workbench/contributions";
import { useDistractionFree } from "@/workbench/distractionFree";
import { ENCODING_CHOICES, useEditorPrefs } from "@/platform/editorSettings";
import { isVirtualUri, invalidateVirtualDocument } from "@/platform/virtualDocs";
import { editorController, isTextInput, useEditorStatus, useGotoLine, useTabs } from "../controller";
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
 * The active tab's path, known as soon as the tab becomes active — before its
 * editor slot reports a status. Switching to a file that is still loading (or
 * replacing a preview tab) would otherwise leave the bar without a path.
 */
function useActiveTabPath(): string | null {
  return useTabs((s) => {
    const pane = s.panes[s.activePane];
    const tab = pane?.tabs.find((t) => t.id === pane.active);
    return tab && isTextInput(tab.input) ? tab.input.path : null;
  });
}

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

/** The project (or workspace member) node: the first crumb of every navigation path. */
function projectCrumb(project: { root: string; name: string }): Crumb {
  return {
    label: project.name,
    icon: "module",
    title: project.root,
    nav: { kind: "dir", path: project.root, label: project.name, root: true },
  };
}

/** The project › dirs › file part of the navigation path (IDEA navigation bar). */
function pathCrumbs(project: { root: string; name: string } | null, path: string, dir = false): Crumb[] {
  const target = dir ? path : dirname(path);
  const segments: Crumb[] = [];
  if (project && target !== project.root && !target.startsWith(project.root + "/")) project = null;
  if (project) segments.push(projectCrumb(project));
  else {
    const label = basename(target) || target;
    segments.push({ label, icon: "folder", title: target, nav: { kind: "dir", path: target, label } });
  }
  if (project && target !== project.root && target.startsWith(project.root + "/")) {
    // Every directory from the root to the file, eliding the middle of deep paths.
    const dirs = relativePath(project.root, target).split("/");
    const shown = dirs.length > 4 ? [...dirs.slice(0, 1), "…", ...dirs.slice(-2)] : dirs;
    let consumed = 0;
    for (const label of shown) {
      if (label === "…") {
        consumed = dirs.length - 2;
        segments.push({
          label,
          title: dirs.join("/"),
          run: () => void executeAction("navigate.selectIn", { path: target }),
        });
        continue;
      }
      consumed += 1;
      const at = `${project.root}/${dirs.slice(0, consumed).join("/")}`;
      segments.push({
        label,
        icon: "folder",
        title: relativePath(project.root, at),
        nav: { kind: "dir", path: at, label },
      });
    }
  }
  if (dir) return segments;
  const file = basename(path);
  segments.push({
    label: file,
    icon: fileIconName(file),
    title: project ? relativePath(project.root, path) : path,
    nav: { kind: "file", path, label: file },
  });
  return segments;
}

/** A row of crumbs; a segment with `nav` opens a popup of its children. */
function CrumbNav({ segments, className, ariaLabel }: { segments: Crumb[]; className?: string; ariaLabel?: string }) {
  const [popup, setPopup] = useState<{ nav: NavSegment; anchor: HTMLElement } | null>(null);
  return (
    <nav
      className={className}
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(e.target as HTMLButtonElement);
        if (index < 0) return;
        let next: number;
        if (e.key === "ArrowLeft") next = Math.max(0, index - 1);
        else if (e.key === "ArrowRight") next = Math.min(buttons.length - 1, index + 1);
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = buttons.length - 1;
        else if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          buttons[index]?.click();
          return;
        } else return;
        e.preventDefault();
        e.stopPropagation();
        buttons[next]?.focus();
      }}
    >
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
            {s.icon && <Icon name={s.icon} size={16} className={styles.crumbIcon} />}
            <span className={styles.crumbLabel}>{s.label}</span>
          </BarButton>
        </Fragment>
      ))}
      {popup && <NavChildrenPopup segment={popup.nav} anchor={popup.anchor} onClose={() => setPopup(null)} />}
    </nav>
  );
}

/**
 * IDEA new UI navigation bar (the top of the workbench, or the status bar
 * footer via `inStatusBar`): project › dirs › file › symbols, with icons;
 * clicking a segment opens a popup of its children.
 */
export function Breadcrumbs({ className, inStatusBar = false }: { className?: string; inStatusBar?: boolean }) {
  const statusPath = useEditorStatus((s) => s.status?.path ?? null);
  const activeTabPath = useActiveTabPath();
  // The project view's node wins while the tree is the user's context (IDEA's bar
  // follows it, e.g. a folder selected there), then the editor's file.
  const lead = useProjectViewLead((s) => s.lead);
  const path = lead?.path ?? activeTabPath ?? statusPath;
  const currentProject = useProject((s) => s.project);
  const project = projectFolder(currentProject, path ?? "");
  const outline = useOutline((s) => (path ? s[path] : undefined));
  const chain = useCaretSymbols(path, outline) ?? NO_SYMBOLS;
  const position = useProject((s) => s.settings?.appearance?.navigationBar);
  // The status bar is the default (where the bar lived before the three-state
  // choice), so the footer instance shows unless the user moved the bar to the
  // top or hid it; the workbench top instance only renders for an explicit
  // `top` (its caller gates the same way).
  const shown = inStatusBar ? position !== "top" && position !== "hidden" : position === "top";
  const distractionFree = useDistractionFree((s) => s.active);
  if (!shown || distractionFree) return null;
  const segments: Crumb[] = [];
  const isDir = !!lead && lead.path === path && lead.dir;
  if (path) {
    segments.push(...pathCrumbs(project, path, isDir));
    const file = basename(path);
    const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) || file : file;
    if (!isDir)
      for (const item of chain.filter((it, i) => i > 0 || it.name !== stem))
        segments.push({
          label: item.name,
          icon: `symbol-${badgeKind(item.kind)}`,
          title: item.detail ?? item.name,
          nav: { kind: "symbol", path, label: item.name, item },
        });
  } else if (!inStatusBar && currentProject) {
    // The top bar keeps its row: opening, closing or switching a tab clears the
    // active editor's status for a frame, and with no editor open IDEA still
    // shows the project node instead of dropping the bar's height.
    segments.push(projectCrumb(project ?? currentProject));
  }
  if (!segments.length) return null;
  return <CrumbNav segments={segments} className={className ?? styles.status} ariaLabel={tx("Breadcrumbs")} />;
}

/** The status bar instance of the navigation bar; renders only for `statusBar`. */
export function StatusBarBreadcrumbs() {
  return <Breadcrumbs inStatusBar />;
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
  const prefs = useEditorPrefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!meta) return null;
  const apply = (encoding: string, reload: boolean) => {
    const model = editorController().manager.get(meta.path);
    if (!model) return;
    void editorController()
      .manager.backend.setEncoding(meta.doc, encoding, reload)
      .then((enc) => {
        model.setMeta({ encoding: enc.encoding, hasBom: enc.hasBom, ...(reload ? {} : { dirty: true }) });
        // Reopening the tab must fetch the re-decoded contents, not the old cache.
        if (reload && isVirtualUri(meta.path)) invalidateVirtualDocument(meta.path);
      })
      .catch((e: unknown) =>
        notifications().notify({
          level: "error",
          title: reload ? "Cannot reload with encoding" : "Cannot convert encoding",
          body: e instanceof Error ? e.message : String(e),
        }),
      );
  };
  const current = meta.encoding.toLowerCase();
  const nativeToAsciiProperties = prefs.encodings.nativeToAscii && meta.path.endsWith(".properties");
  const canToggleBom = current === "utf-8" && !nativeToAsciiProperties;
  const label = ENCODINGS.find(([id]) => id === current)?.[1] ?? meta.encoding;
  const applyBom = (hasBom: boolean) => {
    const controller = editorController();
    const model = controller.manager.get(meta.path);
    if (!model) return;
    void controller.manager.backend
      .setBom(meta.doc, hasBom)
      .then(async (enc) => {
        model.setMeta({ encoding: enc.encoding, hasBom: enc.hasBom, dirty: true });
        if (controller.autoSave()) await model.save("auto");
      })
      .catch((e: unknown) =>
        notifications().notify({
          level: "error",
          title: tx("Cannot change the UTF-8 BOM"),
          body: e instanceof Error ? e.message : String(e),
        }),
      );
  };
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
        {meta.hasBom ? `${label} BOM` : label}
      </BarButton>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        placement="top-end"
        aria-label="File encoding"
        items={[
          {
            id: "reload",
            label: "Reload with Encoding",
            disabled: meta.dirty || !meta.canReloadEncoding,
            submenu: group(true),
          },
          { id: "convert", label: "Convert to Encoding", disabled: meta.readOnly, submenu: group(false) },
          ...(canToggleBom
            ? [
                { kind: "separator" as const },
                {
                  id: "toggle-bom",
                  label: meta.hasBom ? "Remove UTF-8 BOM" : "Add UTF-8 BOM",
                  disabled: meta.readOnly,
                  run: () => applyBom(!meta.hasBom),
                },
              ]
            : []),
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
