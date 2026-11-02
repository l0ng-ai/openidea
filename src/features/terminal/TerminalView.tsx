import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { useProject } from "@/platform/project";
import { toolWindowService } from "@/workbench/contributions";
import { ToolWindowHeader, useOwnToolWindowHeader } from "@/workbench/toolwindows/ToolWindows";
import { usePlatform } from "@/platform/platformInfo";
import { commands, isTauri } from "@/platform/ipc";
import {
  IconButton,
  Input,
  Menu,
  Popup,
  showContextMenu,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  type MenuItem,
  type TabItem,
} from "@/ui";
import {
  activateGroup,
  activeSession,
  getSession,
  groupTabs,
  layoutGroups,
  moveTab,
  newTab,
  publishFocus,
  renameTab,
  requestCloseSession,
  requestCloseTab,
  selectTab,
  tabFullTitle,
  tabTitle,
  topRightGroup,
  useTerminals,
  type GroupLayout,
  type TerminalTab,
} from "./store";
import { TerminalFindBar } from "./FindBar";
import styles from "./Terminal.module.css";

const TAB_PREFIX = "openidea-terminal";
/**
 * Drag type of terminal tabs: dragging one reorders its group's strip or moves
 * it to another group's, like IDEA's terminal tabs.
 */
const TAB_MIME = "application/x-openidea-terminal-tab";

/** Full title when the label is trimmed, then the working directory. */
function tabTooltip(tab: TerminalTab, sessions: Parameters<typeof tabTitle>[1]): string | undefined {
  const full = tabFullTitle(tab, sessions);
  const cwd = sessions?.[tab.session]?.cwd;
  if (full === tabTitle(tab, sessions)) return cwd;
  return cwd ? `${full}\n${cwd}` : full;
}

function TerminalPane({ sessionKey, autofocus }: { sessionKey: string; autofocus: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useTerminals((s) => s.sessions[sessionKey]?.status);
  const follow = useTerminals((s) => s.sessions[sessionKey]?.follow ?? true);

  useLayoutEffect(() => {
    const el = ref.current;
    const session = getSession(sessionKey);
    if (!el || !session) return;
    session.attach(el);
    return () => session.detach(el);
  }, [sessionKey]);

  return (
    <div
      ref={ref}
      className={clsx(styles.pane, (status === "exited" || status === "error") && styles.exited)}
      tabIndex={-1}
      data-autofocus={autofocus ? "" : undefined}
      onFocus={(e) => {
        // The tool window focuses the pane; hand focus on to xterm's textarea.
        if (e.target === e.currentTarget) getSession(sessionKey)?.focus();
      }}
      onContextMenu={(e) => paneMenu(e, sessionKey)}
    >
      <div className={styles.paneActions} role="toolbar" aria-label="Terminal actions">
        <IconButton
          icon="arrow-down"
          iconSize={14}
          title="Scroll to End"
          pressed={follow}
          onClick={() => getSession(sessionKey)?.setFollow(!follow)}
        />
      </div>
    </div>
  );
}

function paneMenu(e: MouseEvent, key: string) {
  e.preventDefault();
  const session = getSession(key);
  if (!session) return;
  // Right-clicking focuses the terminal, like IDEA; otherwise the menu closing
  // restores focus to whatever was focused before it, often the editor.
  session.focus();
  const exited = session.state.status === "exited" || session.state.status === "error";
  const mac = usePlatform.getState().os === "macos";
  const items: MenuItem[] = [
    {
      label: "Copy",
      icon: "copy",
      shortcut: mac ? "⌘C" : "Ctrl+Shift+C",
      disabled: !session.hasSelection,
      run: () => session.copySelection(),
    },
    {
      label: "Paste",
      shortcut: mac ? "⌘V" : "Ctrl+Shift+V",
      run: () => void session.pasteClipboard(),
    },
    { label: "Select All", run: () => session.term.selectAll() },
    { kind: "separator" },
    { label: "Clear Buffer", shortcut: mac ? "⌘K" : undefined, run: () => session.clear() },
    { kind: "separator" },
    { kind: "action", action: "terminal.splitRight" },
    { kind: "action", action: "terminal.splitDown" },
    {
      label: "Close Session",
      icon: "close",
      run: () =>
        void requestCloseSession(key).then((closed) => {
          if (closed) requestAnimationFrame(() => activeSession()?.focus());
        }),
    },
  ];
  if (exited)
    items.splice(
      0,
      0,
      { label: "Restart Session", icon: "rerun", run: () => session.restart() },
      { kind: "separator" },
    );
  showContextMenu(e, items);
}

/** The groups of a split window whose headers show its title and its buttons. */
interface Corners {
  title: string;
  actions: string;
}

function LayoutNode({ node, corners }: { node: GroupLayout; corners: Corners | null }) {
  if (typeof node === "string") return <TabGroup group={node} corners={corners} />;
  return (
    <SplitGroup orientation={node.orientation} className={styles.split} id={`terminal-split-${node.id}`}>
      {node.children.map((child, i) => {
        const id = typeof child === "string" ? child : child.id;
        return (
          <Fragment key={id}>
            {i > 0 && <SplitHandle />}
            <SplitPanel id={id} minSize={60} className={styles.splitPanel}>
              <LayoutNode node={child} corners={corners} />
            </SplitPanel>
          </Fragment>
        );
      })}
    </SplitGroup>
  );
}

/** A tab group: its own header while the window is split, then its selected tab's terminal. */
function TabGroup({ group, corners }: { group: string; corners: Corners | null }) {
  const allTabs = useTerminals((s) => s.tabs);
  const selected = useTerminals((s) => s.selected[group] ?? null);
  const activeTab = useTerminals((s) => s.activeTab);
  const tabs = useMemo(() => groupTabs(allTabs, group), [allTabs, group]);
  const active = tabs.find((t) => t.id === activeTab);
  return (
    <div className={styles.group}>
      {corners && (
        <ToolWindowHeader title={corners.title === group} actions={corners.actions === group} closeTarget={!!active}>
          <GroupTabs group={group} />
        </ToolWindowHeader>
      )}
      {active && <TerminalFindBar sessionKey={active.session} />}
      <div className={styles.panels}>
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            id={`${TAB_PREFIX}-panel-${t.id}`}
            aria-labelledby={`${TAB_PREFIX}-tab-${t.id}`}
            className={styles.panel}
            hidden={t.id !== selected}
          >
            <TerminalPane sessionKey={t.session} autofocus={t.id === activeTab} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RenamePopup({ tab, anchor, onClose }: { tab: TerminalTab; anchor: Element; onClose: () => void }) {
  const [value, setValue] = useState(() => tabTitle(tab, useTerminals.getState().sessions));
  return (
    <Popup open anchor={anchor} onClose={onClose} placement="bottom-start" aria-label="Rename tab" trapFocus>
      <form
        className={styles.rename}
        onSubmit={(e) => {
          e.preventDefault();
          renameTab(tab.id, value);
          onClose();
        }}
      >
        <Input
          data-autofocus=""
          aria-label="Tab name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
      </form>
    </Popup>
  );
}

export function TerminalView() {
  const layout = useTerminals((s) => s.layout);
  const root = useProject((s) => s.project?.root);
  const rootRef = useRef<HTMLDivElement>(null);
  const split = typeof layout !== "string";
  // Split, each group shows a header of its own, as in IDEA.
  useOwnToolWindowHeader(split);

  // Showing an empty terminal window opens a "Local" tab, like IDEA. The window stays
  // mounted while hidden, so wait until it takes space again (not right after the last
  // tab closed and hid it).
  useEffect(() => {
    const el = rootRef.current;
    if (!root || !el) return;
    const ensureTab = () => {
      if (el.clientHeight > 0 && useTerminals.getState().tabs.length === 0) newTab(root);
    };
    ensureTab();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(ensureTab);
    ro.observe(el);
    return () => ro.disconnect();
  }, [root]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onFocusCapture={(e) => publishFocus(!!(e.target as Element).closest?.("[data-terminal-session]"))}
      onBlurCapture={() => publishFocus(false)}
    >
      <LayoutNode
        node={layout}
        corners={split ? { title: layoutGroups(layout)[0]!, actions: topRightGroup(layout) } : null}
      />
    </div>
  );
}

let shellList: Promise<string[]> | null = null;

/** Installed shells, looked up once. */
function availableShells(): Promise<string[]> {
  if (!isTauri()) return Promise.resolve([]);
  shellList ??= commands.termAvailableShells().catch(() => {
    shellList = null;
    return [];
  });
  return shellList;
}

/** "zsh", or "bash (/opt/homebrew/bin/bash)" when several shells share a name. */
export function shellItems(paths: string[]): MenuItem[] {
  const name = (p: string) =>
    p
      .split(/[\\/]/)
      .pop()!
      .replace(/\.exe$/i, "");
  return paths.map((p) => ({
    kind: "action",
    action: "terminal.newPredefinedSession",
    arg: p,
    label: paths.filter((q) => name(q) === name(p)).length > 1 ? `${name(p)} (${p})` : name(p),
    icon: "",
  }));
}

/** Session tabs shown in the tool window header while it isn't split: "Local ×  +  ▾". */
export function TerminalTabs() {
  const group = useTerminals((s) => layoutGroups(s.layout)[0]!);
  return <GroupTabs group={group} />;
}

/** Focuses the active tab's terminal once the panes have (re-)mounted. */
function focusActiveTab(raf: { current: number }) {
  cancelAnimationFrame(raf.current);
  raf.current = requestAnimationFrame(() => activeSession()?.focus());
}

/** A tab group's session tabs. */
function GroupTabs({ group }: { group: string }) {
  const allTabs = useTerminals((s) => s.tabs);
  const selected = useTerminals((s) => s.selected[group] ?? null);
  const sessions = useTerminals((s) => s.sessions);
  const split = useTerminals((s) => typeof s.layout !== "string");
  const tabs = useMemo(() => groupTabs(allTabs, group), [allTabs, group]);
  const [renaming, setRenaming] = useState<{ id: string; anchor: Element } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shells, setShells] = useState<string[]>([]);
  const menuRef = useRef<HTMLButtonElement>(null);
  const focusRaf = useRef(0);

  const items: TabItem[] = tabs.map((t) => {
    const status = sessions[t.session]?.status;
    const dead = status === "exited" || status === "error";
    return {
      id: t.id,
      label: tabTitle(t, sessions),
      closable: true,
      italic: dead,
      color: dead ? "var(--fg-subtle)" : undefined,
      tooltip: tabTooltip(t, sessions),
    };
  });

  const onClose = async (id: string) => {
    if (!(await requestCloseTab(id))) return;
    if (useTerminals.getState().tabs.length === 0) toolWindowService().hide("terminal");
    else focusActiveTab(focusRaf);
  };

  const tabMenu = (id: string, e: MouseEvent) => {
    e.preventDefault();
    const anchor = (e.currentTarget as Element) ?? null;
    const others = tabs.length > 1;
    showContextMenu(e, [
      { label: "Rename Session…", icon: "edit", run: () => setRenaming({ id, anchor }) },
      { kind: "separator" },
      { label: "Close Tab", icon: "close", run: () => void onClose(id) },
      {
        label: "Close Other Tabs",
        disabled: !others,
        run: async () => {
          for (const t of tabs.filter((x) => x.id !== id)) if (!(await requestCloseTab(t.id))) return;
          focusActiveTab(focusRaf);
        },
      },
      { kind: "separator" },
      // IDEA's tool window splits: each part gets its own tabs.
      { kind: "action", action: "terminal.splitRight", arg: id },
      ...(others ? [{ kind: "action" as const, action: "terminal.splitAndMoveRight", arg: id }] : []),
      { kind: "action", action: "terminal.splitDown", arg: id },
      ...(others ? [{ kind: "action" as const, action: "terminal.splitAndMoveDown", arg: id }] : []),
      ...(split ? [{ kind: "action" as const, action: "terminal.unsplit", arg: group }] : []),
    ]);
  };

  const renameTarget = renaming && tabs.find((t) => t.id === renaming.id);
  const moreItems: MenuItem[] = [
    { kind: "action", action: "terminal.new" },
    { kind: "separator" },
    { kind: "header", label: "New Predefined Session" },
    ...shellItems(shells),
    { kind: "action", action: "ssh.startSession", label: "SSH Session…" },
    { kind: "separator" },
    { kind: "action", action: "terminal.splitRight" },
    { kind: "action", action: "terminal.splitDown" },
    { kind: "separator" },
    { kind: "action", action: "file.settings", arg: "tools.terminal", label: "Settings", icon: "settings" },
  ];

  return (
    <div
      className={styles.tabs}
      onDoubleClick={(e) => {
        const tabEl = (e.target as Element).closest?.<HTMLElement>("[role=tab]");
        const id = tabEl?.id.startsWith(`${TAB_PREFIX}-tab-`) ? tabEl.id.slice(`${TAB_PREFIX}-tab-`.length) : null;
        if (tabEl && id) {
          cancelAnimationFrame(focusRaf.current);
          setRenaming({ id, anchor: tabEl });
        }
      }}
    >
      <Tabs
        variant="compact"
        className={styles.tabStrip}
        aria-label="Terminal sessions"
        items={items}
        activeId={selected}
        onSelect={(id) => {
          selectTab(id);
          focusActiveTab(focusRaf);
        }}
        onClose={(id) => void onClose(id)}
        onContextMenu={tabMenu}
        panelIdPrefix={TAB_PREFIX}
        dnd={{
          type: TAB_MIME,
          payload: (id) => id,
          onDrop: (id, index) => {
            moveTab(id, group, index);
            focusActiveTab(focusRaf);
          },
        }}
        trailing={
          <div className={styles.tabActions}>
            {/* New Tab and the menu's actions go to this group. */}
            <IconButton
              icon="plus"
              size="small"
              action="terminal.new"
              title="New Tab"
              onClick={() => activateGroup(group)}
            />
            <IconButton
              ref={menuRef}
              icon="chevron-down"
              size="small"
              title="More Terminal Options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                if (!menuOpen) {
                  activateGroup(group);
                  void availableShells().then(setShells);
                }
                setMenuOpen((v) => !v);
              }}
            />
            <Menu open={menuOpen} anchor={menuRef} items={moreItems} onClose={() => setMenuOpen(false)} />
          </div>
        }
      />
      {renaming && renameTarget && (
        <RenamePopup tab={renameTarget} anchor={renaming.anchor} onClose={() => setRenaming(null)} />
      )}
    </div>
  );
}
