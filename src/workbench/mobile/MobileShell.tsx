/**
 * The workbench on a phone: one page at a time above a bottom bar, instead of
 * tool window stripes and side panels around the editor. Pages are the
 * registered tool windows themselves (`ToolWindowView`, header and all) and the
 * editor area; More lists the tool windows without a place in the bar.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { T } from "@/ui/T";
import { Icon } from "@/ui";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { EditorArea } from "../EditorArea";
import { ProjectButton, TitleItem, VcsFallback } from "../TitleBar";
import { useContributions, type ToolWindowContribution } from "../contributions";
import { showToolWindow } from "../toolwindows/store";
import { ToolWindowAsPage, ToolWindowView, useToolWindowPageNavs } from "../toolwindows/ToolWindows";
import { toolWindowTitle } from "../toolwindows/title";
import { toolWindowApplies, useToolWindowAvailability } from "../toolwindows/availability";
import {
  GIT_VIEWS,
  installMobileShellFollow,
  PAGE_OF_TOOL_WINDOW,
  popEditor,
  setMobilePage,
  toolWindowOfPage,
  useMobileShell,
  type GitView,
  type MobilePage,
} from "./store";
import {
  compareSlots,
  isTabSlot,
  MAX_TABS,
  moveTab,
  setEditingTabs,
  toggleTab,
  useMobileTabs,
  type TabSlot,
} from "./tabs";
import styles from "./MobileShell.module.css";

interface Tab {
  page: MobilePage;
  label: string;
  icon: string;
  /** The tool window whose badge the tab shows. */
  badgeOf?: ToolWindowContribution;
}

const PAGE_TOOL_WINDOW: Partial<Record<MobilePage, string>> = { agents: "agents", database: "database" };

function Badge({ tw }: { tw: ToolWindowContribution }) {
  const value = tw.useBadge!();
  if (value == null || value === 0) return null;
  return <span className={styles.badge}>{value}</span>;
}

function TabButton({
  tab,
  current,
  editing,
  dragged,
}: {
  tab: Tab;
  current: boolean;
  editing: boolean;
  dragged: boolean;
}) {
  const tw = tab.badgeOf;
  const movable = editing && tab.page !== "more";
  return (
    <button
      type="button"
      className={clsx(styles.tab, movable && styles.tabMovable, dragged && styles.tabDragged)}
      data-tab={movable ? tab.page : undefined}
      aria-current={current ? "page" : undefined}
      onClick={() => {
        if (editing) return;
        if (isTabSlot(tab.page)) openDestination(tab.page);
        else setMobilePage(tab.page);
      }}
    >
      <span className={styles.tabIcon}>
        <Icon name={tab.icon} size={22} />
        {tw?.useBadge && <Badge key={tw.id} tw={tw} />}
      </span>
      <span className={styles.tabLabel}>{tab.label}</span>
    </button>
  );
}

const asTab = (d: Destination): Tab => ({ page: d.slot, label: d.label, icon: d.icon, badgeOf: d.badgeOf });

/**
 * The bottom bar; while More edits it (Edit Tab Bar, or a long press on the bar) its tabs
 * (all but More) drag to a new place.
 */
function TabBar({ tabs, current, editing }: { tabs: Tab[]; current: MobilePage; editing: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [dragged, setDragged] = useState<MobilePage | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const tab = (e.target as Element).closest<HTMLElement>("[data-tab]")?.dataset.tab as MobilePage | undefined;
    if (!editing || !tab) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragged(tab);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const bar = ref.current;
    if (!dragged || !bar) return;
    const rect = bar.getBoundingClientRect();
    // More keeps the last place.
    const slot = Math.floor(((e.clientX - rect.left) / rect.width) * tabs.length);
    const target = tabs[Math.max(0, Math.min(tabs.length - 2, slot))]?.page;
    const order = useMobileTabs.getState().tabs as MobilePage[];
    if (target && target !== dragged) moveTab(order.indexOf(dragged), order.indexOf(target));
  };
  const end = () => setDragged(null);
  return (
    <nav
      ref={ref}
      className={clsx(styles.tabBar, editing && styles.tabBarEditing)}
      aria-label={tx("Tool Windows")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      // A long press on the bar edits it (on More).
      onContextMenu={(e) => {
        e.preventDefault();
        setMobilePage("more");
        setEditingTabs(true);
      }}
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.page}
          tab={tab}
          current={tab.page === current}
          editing={editing}
          dragged={tab.page === dragged}
        />
      ))}
    </nav>
  );
}

function toolWindowOfGit(): string | null {
  const windows = useContributions.getState().toolWindows;
  return toolWindowOfPage("git", useMobileShell.getState().gitView, (id) => windows.has(id));
}

/** A page the bar or More can open: a fixed page (Agents, Git, Database) or a tool window. */
interface Destination {
  slot: TabSlot;
  label: string;
  icon: string;
  badgeOf?: ToolWindowContribution;
}

function openDestination(slot: TabSlot) {
  const id = slot.startsWith("tool:")
    ? slot.slice("tool:".length)
    : slot === "git"
      ? toolWindowOfGit()
      : PAGE_TOOL_WINDOW[slot];
  if (id) showToolWindow(id, slot.startsWith("tool:"));
  setMobilePage(slot);
}

function MorePage({ destinations }: { destinations: Destination[] }) {
  const tabs = useMobileTabs((s) => s.tabs);
  const editing = useMobileTabs((s) => s.editing);
  const [full, setFull] = useState(false);
  // Leaving More ends editing.
  useEffect(() => () => setEditingTabs(false), []);
  // Editing shows the pages in the bar too, to take them off.
  const shown = editing ? destinations : destinations.filter((d) => !tabs.includes(d.slot));
  return (
    <div className={styles.more}>
      {editing && (
        <div className={styles.moreHead}>
          <p className={clsx(styles.editHint, full && styles.editHintFull)}>
            {tx`Choose up to ${MAX_TABS} pages for the tab bar. Drag tabs to reorder them.`}
          </p>
          <button type="button" className={styles.editLink} onClick={() => setEditingTabs(false)}>
            <T>Done</T>
          </button>
        </div>
      )}
      <div className={styles.grid}>
        {shown.map((d) => {
          const pinned = tabs.includes(d.slot);
          return (
            <button
              key={d.slot}
              type="button"
              className={clsx(styles.tile, editing && pinned && styles.tilePinned)}
              aria-pressed={editing ? pinned : undefined}
              onClick={() => (editing ? setFull(!toggleTab(d.slot)) : openDestination(d.slot))}
            >
              <span className={styles.tileIcon}>
                <Icon name={d.icon} size={22} />
                {editing ? (
                  <span className={clsx(styles.tileMark, pinned && styles.tileMarkOn)} aria-hidden="true">
                    <Icon name={pinned ? "check" : "plus"} size={10} />
                  </span>
                ) : (
                  d.badgeOf?.useBadge && <Badge tw={d.badgeOf} />
                )}
              </span>
              <span className={styles.tileLabel}>{d.label}</span>
            </button>
          );
        })}
      </div>
      {!editing && (
        <button
          type="button"
          className={styles.editLink}
          onClick={() => {
            setFull(false);
            setEditingTabs(true);
          }}
        >
          <T>Edit Tab Bar</T>
        </button>
      )}
    </div>
  );
}

function GitSwitcher({ windows, view }: { windows: Map<string, ToolWindowContribution>; view: GitView }) {
  const shown = GIT_VIEWS.filter((id) => windows.has(id));
  if (shown.length < 2) return null;
  return (
    <div className={styles.segments} role="tablist" aria-label="Git">
      {shown.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={id === view}
          className={styles.segment}
          onClick={() => {
            useMobileShell.setState({ gitView: id });
            showToolWindow(id);
          }}
        >
          {id === "git" ? tx("Log") : toolWindowTitle(windows.get(id)!)}
        </button>
      ))}
    </div>
  );
}

export function MobileShell() {
  const { page, gitView, returnTo } = useMobileShell();
  const windows = useContributions((s) => s.toolWindows);
  const branchWidget = useContributions((s) => s.titleItems.get("vcs.branch"));
  const current = toolWindowOfPage(page, gitView, (id) => windows.has(id));
  const nav = useToolWindowPageNavs((s) => (current && page !== "editor" ? s.navs.get(current) : undefined));
  // Tool windows stay mounted once shown, so a page keeps its state when the user comes back.
  const [visited, setVisited] = useState<string[]>([]);
  if (current && windows.has(current) && !visited.includes(current)) setVisited([...visited, current]);

  useEffect(() => installMobileShellFollow(), []);

  const titled = (id: string, fallback: string) => {
    const tw = windows.get(id);
    return tw ? toolWindowTitle(tw) : tx(fallback);
  };
  const pinned = useMobileTabs((s) => s.tabs);
  const unavailable = useToolWindowAvailability((s) => s.unavailable);
  const usage = useMobileTabs((s) => s.usage);
  const destinations: Destination[] = [
    windows.has("agents") && {
      slot: "agents",
      label: titled("agents", "Agents"),
      icon: "toolwindow-agents",
      badgeOf: windows.get("agents"),
    },
    GIT_VIEWS.some((id) => windows.has(id)) && {
      slot: "git",
      label: "Git",
      icon: "toolwindow-git",
      badgeOf: windows.get("commit"),
    },
    windows.has("database") && { slot: "database", label: titled("database", "Database"), icon: "toolwindow-database" },
    ...[...windows.values()]
      .filter((tw) => !(tw.id in PAGE_OF_TOOL_WINDOW) && (toolWindowApplies(tw, unavailable) || tw.id === current))
      .map((tw): Destination => ({ slot: `tool:${tw.id}`, label: toolWindowTitle(tw), icon: tw.icon, badgeOf: tw })),
  ].filter((d): d is Destination => !!d);
  const bySlot = new Map(destinations.map((d) => [d.slot, d]));
  destinations.sort((a, b) => compareSlots(usage, a.slot, b.slot, (s) => bySlot.get(s)?.label ?? s));
  const tabs: Tab[] = [
    ...pinned.flatMap((item): Tab[] => {
      if (item === "editor") return [{ page: "editor", label: tx("Editor"), icon: "file-code" }];
      const d = bySlot.get(item);
      return d ? [asTab(d)] : [];
    }),
    { page: "more", label: tx("More"), icon: "more-horizontal" },
  ];
  // A page off the bar is reached from More, and leads back there.
  const offBar = isTabSlot(page) && !pinned.includes(page);
  const editing = useMobileTabs((s) => s.editing);
  // An editor shown over a page keeps that page's tab lit.
  const shownPage = returnTo ?? page;
  const tabPage = isTabSlot(shownPage) && !pinned.includes(shownPage) ? "more" : shownPage;

  return (
    <div className={styles.shell} data-mobile-shell="">
      {nav ? (
        // A tool window at a sub-page: the top bar is its navigation bar.
        <header className={clsx(styles.appBar, styles.navBar)}>
          <button type="button" className={styles.iconButton} aria-label={tx("Back")} onClick={nav.back}>
            <Icon name="chevron-left" size={22} />
          </button>
          <div className={styles.navTitle}>
            <span className={styles.navTitleText}>{nav.title}</span>
            {nav.detail && <span className={styles.navDetail}>{nav.detail}</span>}
          </div>
          <div className={styles.navActions}>{nav.actions}</div>
        </header>
      ) : (
        <header className={styles.appBar}>
          {offBar || returnTo ? (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={tx("Back")}
              onClick={() => (returnTo ? popEditor() : setMobilePage("more"))}
            >
              <Icon name="chevron-left" size={22} />
            </button>
          ) : null}
          <div className={styles.switchers}>
            <ProjectButton />
            {branchWidget ? <TitleItem item={branchWidget} /> : <VcsFallback />}
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={tx("Search Everywhere")}
            onClick={() => void executeAction("navigate.searchEverywhere")}
          >
            <Icon name="search" size={20} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={tx("Settings")}
            onClick={() => void executeAction("file.settings")}
          >
            <Icon name="settings" size={20} />
          </button>
        </header>
      )}
      {page === "git" && <GitSwitcher windows={windows} view={gitView} />}
      <ToolWindowAsPage.Provider value={true}>
        <main className={styles.pages}>
          <div className={styles.page} hidden={page !== "editor"}>
            <EditorArea />
          </div>
          {visited.map((id) => {
            const tw = windows.get(id);
            return tw ? (
              <div key={id} className={styles.page} hidden={id !== current}>
                <ToolWindowView tw={tw} hidden={id !== current} />
              </div>
            ) : null;
          })}
          {page === "more" && (
            <div className={styles.page}>
              <MorePage destinations={destinations} />
            </div>
          )}
        </main>
      </ToolWindowAsPage.Provider>
      <TabBar tabs={tabs} current={tabPage} editing={editing} />
    </div>
  );
}
