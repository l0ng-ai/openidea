/**
 * Settings (⌘,): search + page tree on the left, page host with breadcrumb and
 * scope switch on the right, OK / Cancel / Apply below (macOS: Cancel / Apply / OK).
 *
 * `SettingsLayout` + `SettingsFooter` render either in the native Settings
 * window (`SettingsWindow`, desktop) or inside `SettingsDialog`, the in-page
 * fallback for the browser build and tests.
 */
import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useProject } from "@/platform/project";
import { SettingsFormContext, useSettingsPages, type SettingsPageContribution } from "@/workbench/contributions";
import {
  Dialog,
  DialogButtons,
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  Tree,
  type DialogButton,
  type TreeHandle,
  T,
} from "@/ui";
import { PageContext, useSettingsFormFor } from "../components/context";
import { SearchLabel } from "../components/Form";
import { breadcrumb, buildPageTree, filterPageTree, flatten, groupKey, type PageNode } from "../model/pages";
import {
  applySettings,
  closeSettings,
  pendingChanges,
  resetPage,
  selectPage,
  setPageScope,
  setQuery,
  settingsTitle,
  useSettingsDialog,
  type Scope,
} from "../model/staging";
import { builtinSpec, pageLabels } from "../pages/registry";
import { PageErrorBoundary } from "./PageErrorBoundary";
import styles from "./SettingsDialog.module.css";
import { tx } from "@/platform/i18n";

function firstPage(nodes: readonly PageNode[]): string | null {
  const list = flatten(nodes).filter((n) => n.page);
  return (list.find((n) => n.matched) ?? list[0])?.key ?? null;
}

function GroupPage({ node }: { node: PageNode }) {
  return (
    <div className={styles.groupPage}>
      {node.children.map((c) => (
        <button key={c.key} type="button" className={styles.groupLink} onClick={() => selectPage(c.key)}>
          <SearchLabel text={c.title} />
          <Icon name="chevron-right" size={12} />
        </button>
      ))}
    </div>
  );
}

function ScopeSwitch({ pageId, scope }: { pageId: string; scope: Scope }) {
  const options: Array<[Scope, string]> = [
    ["global", "Global"],
    ["project", "This project"],
  ];
  return (
    <div className={styles.scope} role="radiogroup" aria-label={tx("Settings scope")}>
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={scope === value}
          className={clsx(styles.scopeButton, scope === value && styles.scopeOn)}
          onClick={() => setPageScope(pageId, value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function PageHost({
  node,
  page,
  crumbs,
  dirty,
  onReset,
  history,
}: {
  node: PageNode | undefined;
  page: SettingsPageContribution | undefined;
  crumbs: string[];
  dirty: boolean;
  onReset: () => void;
  history: { back?: () => void; forward?: () => void };
}) {
  const pageId = node?.key ?? "";
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const spec = page ? builtinSpec(page.id) : undefined;
  const projectScope = !!(spec?.projectScope ?? page?.projectScope) && hasProject && !newProjects;
  const scopeKey = spec?.scopeGroup ?? pageId;
  const chosen = useSettingsDialog((s) => s.scopes[scopeKey]) ?? spec?.defaultScope;
  const scope: Scope = projectScope && chosen === "project" ? "project" : "global";
  // Where a project value is the norm, say what the global one is for.
  const globalNote = newProjects || (projectScope && scope === "global" && spec?.defaultScope === "project");
  const ctx = useMemo(() => ({ pageId, scope }), [pageId, scope]);
  const form = useSettingsFormFor(pageId, scope);
  if (!node) return <EmptyState title="Nothing found" icon="search" />;
  const Body = page?.component;
  return (
    <PageContext.Provider value={ctx}>
      <SettingsFormContext.Provider value={form}>
        <div className={styles.pageHeader}>
          <div className={styles.crumbs} aria-label={tx("Breadcrumb")}>
            {crumbs.map((c, i) => (
              <span key={i} className={styles.crumb}>
                {i > 0 && <Icon name="chevron-right" size={12} className={styles.crumbSep} />}
                <span>
                  <T>{c}</T>
                </span>
              </span>
            ))}
          </div>
          {dirty && (
            <button type="button" className={styles.reset} onClick={onReset}>
              <T>Reset</T>
            </button>
          )}
          {projectScope && !spec?.ownScopeSwitch && <ScopeSwitch pageId={scopeKey} scope={scope} />}
          <span className={styles.history}>
            <IconButton icon="arrow-left" title="Back" size="small" disabled={!history.back} onClick={history.back} />
            <IconButton
              icon="arrow-right"
              title="Forward"
              size="small"
              disabled={!history.forward}
              onClick={history.forward}
            />
          </span>
        </div>
        {scope === "project" && (
          <div className={styles.scopeNote}>
            <Icon name="info" size={14} />
            <T>Saved to .openidea/settings.toml in this project; overrides the global value.</T>
          </div>
        )}
        {globalNote && (
          <div className={styles.scopeNote}>
            <Icon name="info" size={14} />
            <T>Saved to the global settings: used by new projects and by projects without their own value.</T>
          </div>
        )}
        <div className={styles.pageBody}>
          <PageErrorBoundary pageId={pageId}>{Body ? <Body /> : <GroupPage node={node} />}</PageErrorBoundary>
        </div>
      </SettingsFormContext.Provider>
    </PageContext.Provider>
  );
}

export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  if (!open) return null;
  return <SettingsDialogInner />;
}

export function useSettingsTitle(): string {
  return useSettingsDialog((s) => settingsTitle(s.newProjects));
}

function SettingsDialogInner() {
  return (
    <Dialog
      open
      onClose={closeSettings}
      title={useSettingsTitle()}
      width={980}
      className={styles.dialog}
      footerStart={<SettingsStatus />}
      buttons={useSettingsButtons()}
    >
      <SettingsLayout />
    </Dialog>
  );
}

/** Page tree + current page; reads the shared settings staging store. */
export function SettingsLayout() {
  const pages = useSettingsPages((s) => s.pages);
  const { pageId, query, staged, saving } = useSettingsDialog();
  const treeRef = useRef<TreeHandle>(null);

  const tree = useMemo(() => buildPageTree(pages.values()), [pages]);
  const filtered = useMemo(() => filterPageTree(tree, query, pageLabels), [tree, query]);
  const all = useMemo(() => flatten(tree), [tree]);
  const visible = useMemo(() => flatten(filtered), [filtered]);
  const rootKeys = useMemo(() => new Set(tree.map((n) => n.key)), [tree]);
  const expanded = useMemo(() => new Set(visible.filter((n) => n.children.length).map((n) => n.key)), [visible]);

  const current = all.find((n) => n.key === pageId) ?? all.find((n) => n.page);
  const crumbs = current ? breadcrumb(tree, current.key) : [];
  const dirtyPages = useMemo(() => new Set(Object.values(staged).map((c) => c.page)), [staged]);
  const pageDirty = !!current && dirtyPages.has(current.key);

  // Back / forward through pages visited while the dialog is open.
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const currentKey = current?.key;
  if (currentKey && nav.stack[nav.index] !== currentKey) {
    const stack = [...nav.stack.slice(0, nav.index + 1), currentKey];
    setNav({ stack, index: stack.length - 1 });
  }
  const go = (index: number) => {
    setNav((n) => ({ ...n, index }));
    selectPage(nav.stack[index]!);
  };
  const history = {
    back: nav.index > 0 ? () => go(nav.index - 1) : undefined,
    forward: nav.index < nav.stack.length - 1 ? () => go(nav.index + 1) : undefined,
  };

  const onQuery = (q: string) => {
    setQuery(q);
    const next = flatten(filterPageTree(tree, q, pageLabels));
    if (q && current && !next.some((n) => n.key === current.key && n.matched)) {
      const first = firstPage(next);
      if (first) selectPage(first);
    }
  };

  return (
    <div className={styles.layout}>
      <div className={styles.sidebar}>
        <SearchField
          data-autofocus
          className={styles.search}
          value={query}
          onChange={onQuery}
          placeholder=""
          aria-label="Search settings"
          onKeyDown={(e) => {
            // IDEA: Esc clears the filter before it closes the dialog; ↑/↓ move through the pages, focus stays here.
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              onQuery("");
            } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              treeRef.current?.moveSelection(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        />
        <div className={styles.tree}>
          <Tree<PageNode>
            handleRef={treeRef}
            aria-label="Settings pages"
            roots={filtered}
            getKey={(n) => n.key}
            getLabel={(n) => tx(n.title)}
            getChildren={(n) => (n.children.length ? n.children : undefined)}
            isExpandable={(n) => n.children.length > 0}
            defaultExpanded={all.filter((n) => n.children.length).map((n) => n.key)}
            expanded={query ? expanded : undefined}
            selected={current ? new Set([current.key]) : new Set()}
            onSelectionChange={(_sel, node) => node && selectPage(node.key)}
            multiSelect={false}
            speedSearch={false}
            rowHeight={24}
            empty={
              <div className={styles.noMatch}>
                <T>No matches</T>
              </div>
            }
            renderNode={(n) => (
              <span
                className={clsx(
                  styles.node,
                  rootKeys.has(n.key) && styles.topLevel,
                  dirtyPages.has(n.key) && styles.dirty,
                )}
              >
                <SearchLabel text={n.title} />
              </span>
            )}
          />
        </div>
      </div>
      <div className={styles.main}>
        <PageHost
          node={current}
          page={current?.page}
          crumbs={crumbs}
          dirty={pageDirty && !saving}
          onReset={() => current && resetPage(current.key)}
          history={history}
          key={current?.key ?? groupKey("")}
        />
      </div>
    </div>
  );
}

/** OK / Cancel / Apply, ordered per platform by the dialog primitive. */
function useSettingsButtons(): DialogButton[] {
  const { staged, base, globalBase, saving } = useSettingsDialog();
  const pending = useMemo(() => pendingChanges({ base, globalBase, staged }).length > 0, [base, globalBase, staged]);
  const ok = async () => {
    if (await applySettings()) closeSettings();
  };
  return [
    { label: "OK", role: "default", disabled: saving, onClick: () => void ok() },
    { label: "Cancel", role: "cancel", onClick: closeSettings },
    { label: "Apply", disabled: !pending || saving, onClick: () => void applySettings() },
  ];
}

function SettingsStatus() {
  const error = useSettingsDialog((s) => s.error);
  return (
    <span className={styles.footerStatus} role="status">
      {error && (
        <span className={styles.error}>
          <Icon name="error" size={14} /> Could not save: {error}
        </span>
      )}
    </span>
  );
}

/** Error status + buttons, for the native Settings window. */
export function SettingsFooter() {
  return (
    <>
      <SettingsStatus />
      <DialogButtons buttons={useSettingsButtons()} onCancel={closeSettings} />
    </>
  );
}
