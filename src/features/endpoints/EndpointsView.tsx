/**
 * Endpoints tool window, laid out like IntelliJ's: Module / Type / Framework
 * filters and a details toggle, a search field, the endpoints grouped by
 * module (`/photos/:id [GET]` with the handler class at the right), and a
 * details pane with the HTTP Client request (Submit Request / Open in
 * Editor) and the endpoint's documentation. Framework-neutral: the rows come
 * from the registered providers (`store.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { basename, useProject } from "@/platform/project";
import { editorService, useOccurrenceNavigator } from "@/workbench/contributions";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Menu,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  Tree,
  T,
  type MenuItem,
  type TreeHandle,
  type TreeRowState,
} from "@/ui";
import { generateIntoScratch, renderRequestBlock } from "../http-client/generate";
import { runRequest } from "../http-client/store";
import {
  diagnosticLines,
  distinct,
  filterEndpoints,
  groupBy,
  navigationTarget,
  relativeTo,
  type Endpoint,
  type EndpointGroup,
} from "./model";
import { refreshEndpoints, selectEndpoint, useEndpoints } from "./store";
import styles from "./EndpointsView.module.css";

export const ENDPOINTS_WINDOW = "endpoints";

const OPTIONS_KEY = "openidea.endpoints.view.v1";

interface ViewOptions {
  /** File nodes under the module. */
  groupByFile: boolean;
  /** Selecting an endpoint opens it in the editor. */
  autoscroll: boolean;
  /** The details pane (IntelliJ's eye toggle). */
  details: boolean;
}

function loadOptions(): Partial<ViewOptions> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") as Partial<ViewOptions>;
  } catch {
    return {};
  }
}

export const useEndpointsViewOptions = create<ViewOptions>(() => ({
  groupByFile: false,
  autoscroll: false,
  details: true,
  ...loadOptions(),
}));

useEndpointsViewOptions.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
});

type DetailsTab = "http" | "docs";

interface ViewState {
  query: string;
  /** Unchecked entries of the Module / Type / Framework filters. */
  hiddenModules: Set<string>;
  hiddenTypes: Set<string>;
  hiddenFrameworks: Set<string>;
  collapsed: Set<string>;
  showDiagnostics: boolean;
  tab: DetailsTab;
  /** The endpoint shown in the details pane. */
  currentId: string | null;
}

export const useEndpointsView = create<ViewState>(() => ({
  query: "",
  hiddenModules: new Set(),
  hiddenTypes: new Set(),
  hiddenFrameworks: new Set(),
  collapsed: new Set(),
  showDiagnostics: false,
  tab: "http",
  currentId: null,
}));

/** The tool window's ⋮ menu entries. */
export function useEndpointsHeaderMenu(): MenuItem[] {
  const o = useEndpointsViewOptions();
  const toggle = (key: keyof ViewOptions) => () => useEndpointsViewOptions.setState({ [key]: !o[key] });
  return [
    { id: "group", label: "Group by File", checked: o.groupByFile, run: toggle("groupByFile") },
    { id: "details", label: "Show Details", checked: o.details, run: toggle("details") },
    { id: "autoscroll", label: "Autoscroll to Source", checked: o.autoscroll, run: toggle("autoscroll") },
  ];
}

type Node =
  | { kind: "module"; key: string; name: string; endpoints: Endpoint[] }
  | { kind: "file"; key: string; group: EndpointGroup }
  | { kind: "endpoint"; key: string; endpoint: Endpoint };

export function openEndpoint(e: Endpoint, focus: boolean) {
  const { path, line, col } = navigationTarget(e);
  void editorService().openFile(path, { selection: { line, col }, focus, preview: !focus });
}

/** The endpoints after the search and the filters, in provider order. */
export function useVisibleEndpoints(): Endpoint[] {
  const endpoints = useEndpoints((s) => s.endpoints);
  const query = useEndpointsView((s) => s.query);
  const hiddenModules = useEndpointsView((s) => s.hiddenModules);
  const hiddenTypes = useEndpointsView((s) => s.hiddenTypes);
  const hiddenFrameworks = useEndpointsView((s) => s.hiddenFrameworks);
  return useMemo(
    () =>
      filterEndpoints(
        endpoints.filter(
          (e) => !hiddenModules.has(e.module) && !hiddenTypes.has(e.type) && !hiddenFrameworks.has(e.framework),
        ),
        query,
      ),
    [endpoints, query, hiddenModules, hiddenTypes, hiddenFrameworks],
  );
}

export function EndpointsHeaderActions() {
  const loading = useEndpoints((s) => s.loading);
  const diagnostics = useEndpoints((s) => s.diagnostics.length);
  const showDiagnostics = useEndpointsView((s) => s.showDiagnostics);
  return (
    <>
      {diagnostics > 0 && (
        <IconButton
          icon="warning"
          size="small"
          title={
            diagnostics === 1
              ? tx`${diagnostics} endpoint could not be read`
              : tx`${diagnostics} endpoints could not be read`
          }
          pressed={showDiagnostics}
          tone="danger"
          onClick={() => useEndpointsView.setState({ showDiagnostics: !showDiagnostics })}
        />
      )}
      <IconButton
        icon="refresh"
        size="small"
        title="Refresh"
        disabled={loading}
        onClick={() => void refreshEndpoints()}
      />
    </>
  );
}

/** `Module ▾`: a dropdown of checkable entries. */
function FilterMenu({
  label,
  entries,
  hidden,
  onToggle,
}: {
  label: string;
  entries: string[];
  hidden: ReadonlySet<string>;
  onToggle: (entry: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = entries.map((e) => ({
    id: e,
    label: e,
    verbatim: true,
    checked: !hidden.has(e),
    run: () => onToggle(e),
  }));
  return (
    <>
      <button
        type="button"
        className={clsx(styles.filterButton, hidden.size > 0 && styles.filterActive)}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <T>{label}</T>
        <Icon name="chevron-down" size={16} className={styles.filterChevron} />
      </button>
      <Menu open={!!anchor} anchor={anchor} items={items} onClose={() => setAnchor(null)} aria-label={label} />
    </>
  );
}

function toggleIn(set: Set<string>, entry: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(entry)) next.add(entry);
  return next;
}

function FilterBar() {
  const endpoints = useEndpoints((s) => s.endpoints);
  const providers = useEndpoints((s) => s.providers);
  const project = useProject((s) => s.project?.name ?? "");
  const { hiddenModules, hiddenTypes, hiddenFrameworks } = useEndpointsView();
  const details = useEndpointsViewOptions((o) => o.details);
  const modules = distinct([project, ...endpoints.map((e) => e.module)].filter(Boolean));
  const types = distinct(providers.map((p) => p.type ?? "HTTP"));
  const frameworks = distinct(providers.map((p) => p.framework));
  return (
    <div className={styles.filterBar}>
      <FilterMenu
        label="Module"
        entries={modules}
        hidden={hiddenModules}
        onToggle={(m) => useEndpointsView.setState((s) => ({ hiddenModules: toggleIn(s.hiddenModules, m) }))}
      />
      <FilterMenu
        label="Type"
        entries={types}
        hidden={hiddenTypes}
        onToggle={(t) => useEndpointsView.setState((s) => ({ hiddenTypes: toggleIn(s.hiddenTypes, t) }))}
      />
      <FilterMenu
        label="Framework"
        entries={frameworks}
        hidden={hiddenFrameworks}
        onToggle={(f) => useEndpointsView.setState((s) => ({ hiddenFrameworks: toggleIn(s.hiddenFrameworks, f) }))}
      />
      <span className={styles.spacer} />
      <IconButton
        icon="eye"
        size="small"
        title="Show Details"
        pressed={details}
        onClick={() => useEndpointsViewOptions.setState({ details: !details })}
      />
    </div>
  );
}

function SearchBar() {
  const query = useEndpointsView((s) => s.query);
  return (
    <div className={styles.searchBar}>
      <Icon name="search" size={16} className={styles.searchIcon} />
      <Input
        variant="bare"
        className={styles.search}
        placeholder="Search endpoints"
        aria-label="Search endpoints"
        value={query}
        onChange={(e) => useEndpointsView.setState({ query: e.target.value })}
      />
    </div>
  );
}

function methodClass(method: string): string | undefined {
  switch (method) {
    case "GET":
      return styles.get;
    case "POST":
      return styles.post;
    case "PUT":
    case "PATCH":
      return styles.put;
    case "DELETE":
      return styles.delete;
    default:
      return undefined;
  }
}

function EndpointRow({ endpoint: e }: { endpoint: Endpoint }) {
  return (
    <span className={styles.endpoint} title={`${e.method} ${e.path} → ${e.target}`}>
      <Icon name={e.icon ?? "web"} size={16} className={styles.endpointIcon} />
      <span className={styles.path}>{e.path}</span>
      <span className={clsx(styles.verb, methodClass(e.method))}>[{e.method}]</span>
      <span className={styles.spacer} />
      <span className={styles.controller}>{e.targetClass}</span>
    </span>
  );
}

// --- details pane ----------------------------------------------------------------

function HttpClientTab({ endpoint: e }: { endpoint: Endpoint }) {
  const block = renderRequestBlock(e.request);
  const lines = block.trimEnd().split("\n");
  const submit = () => void runRequest(null, block, 0);
  const openInEditor = () => void generateIntoScratch([block]);
  return (
    <div className={styles.httpTab}>
      <div className={styles.request} role="region" aria-label="HTTP request">
        {lines.map((line, i) => (
          <div key={i} className={clsx(styles.requestLine, i === 1 && styles.requestMain)}>
            <span className={styles.requestGutter}>
              {i === 0 && <IconButton icon="run" size="small" title="Submit Request" onClick={submit} />}
            </span>
            <span className={styles.requestText}>
              {i === 1 ? (
                <>
                  <span className={clsx(styles.verb, methodClass(e.request.method))}>{e.request.method}</span>{" "}
                  {e.request.url}
                </>
              ) : (
                line
              )}
            </span>
          </div>
        ))}
      </div>
      <div className={styles.detailButtons}>
        <Button onClick={submit}>Submit Request</Button>
        <Button onClick={openInEditor}>Open in Editor</Button>
      </div>
    </div>
  );
}

function DocumentationTab({ endpoint: e }: { endpoint: Endpoint }) {
  const root = useProject((s) => s.project?.root ?? "");
  const rows: [string, string][] = [
    ["Path", e.path],
    ["Method", e.method],
    ["Handler", e.target],
    ["Framework", e.framework],
    ...(e.docs ?? []),
  ];
  return (
    <div className={styles.docs}>
      <dl className={styles.docList}>
        {rows.map(([k, v]) => (
          <div key={k} className={styles.docRow}>
            <dt>
              <T>{k}</T>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div className={styles.docRow}>
          <dt>
            <T>Defined in</T>
          </dt>
          <dd>
            <button type="button" className={styles.link} onClick={() => openEndpoint(e, true)}>
              {relativeTo(root, e.file)}:{e.line}
            </button>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function DetailsPane({ endpoint }: { endpoint: Endpoint | null }) {
  const tab = useEndpointsView((s) => s.tab);
  return (
    <div className={styles.details}>
      <Tabs
        variant="compact"
        aria-label="Endpoint details"
        className={styles.detailTabs}
        activeId={tab}
        onSelect={(id) => useEndpointsView.setState({ tab: id as DetailsTab })}
        items={[
          { id: "http", label: "HTTP Client" },
          { id: "docs", label: "Documentation" },
        ]}
      />
      {!endpoint ? (
        <div className={styles.detailEmpty}>
          <T>Select an endpoint</T>
        </div>
      ) : tab === "http" ? (
        <HttpClientTab endpoint={endpoint} />
      ) : (
        <DocumentationTab endpoint={endpoint} />
      )}
    </div>
  );
}

function Diagnostics() {
  const diagnostics = useEndpoints((s) => s.diagnostics);
  const root = useProject((s) => s.project?.root ?? "");
  if (!diagnostics.length) return null;
  const lines = diagnosticLines(diagnostics, root);
  return (
    <div className={styles.diagnostics} role="list" aria-label="Endpoints that could not be read">
      {diagnostics.map((d, i) => (
        <button
          key={`${d.file}:${d.line}:${i}`}
          type="button"
          role="listitem"
          className={styles.diagnostic}
          onClick={() =>
            void editorService().openFile(d.file, { selection: { line: Math.max(0, d.line - 1), col: 0 }, focus: true })
          }
        >
          <Icon name="warning" size={14} className={styles.diagnosticIcon} />
          <span>{lines[i]}</span>
        </button>
      ))}
    </div>
  );
}

// --- the window ------------------------------------------------------------------

const count = (n: number) => (n === 1 ? tx`${n} endpoint` : tx`${n} endpoints`);

export function EndpointsView() {
  const { endpoints: all, available, loading, loaded, error, selectedId } = useEndpoints();
  const endpoints = useVisibleEndpoints();
  const { groupByFile: grouped, details } = useEndpointsViewOptions();
  const showDiagnostics = useEndpointsView((s) => s.showDiagnostics);
  const collapsed = useEndpointsView((s) => s.collapsed);
  const currentId = useEndpointsView((s) => s.currentId);
  const current = useMemo(() => endpoints.find((e) => e.id === currentId) ?? null, [endpoints, currentId]);
  const tree = useRef<TreeHandle>(null);

  useOccurrenceNavigator(ENDPOINTS_WINDOW, (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const n = step?.node as Node | undefined;
    if (!step || n?.kind !== "endpoint") return null;
    openEndpoint(n.endpoint, focus);
    return step;
  });

  const roots = useMemo<Node[]>(
    () =>
      groupBy(endpoints, (e) => e.module).map((g) => ({
        kind: "module",
        key: `module:${g.key}`,
        name: g.key,
        endpoints: g.endpoints,
      })),
    [endpoints],
  );
  const getChildren = useCallback(
    (n: Node): Node[] | undefined => {
      const leaf = (e: Endpoint): Node => ({ kind: "endpoint", key: e.id, endpoint: e });
      if (n.kind === "module")
        return grouped
          ? groupBy(n.endpoints, (e) => e.file).map((g) => ({ kind: "file", key: `file:${n.name}:${g.key}`, group: g }))
          : n.endpoints.map(leaf);
      if (n.kind === "file") return n.group.endpoints.map(leaf);
      return undefined;
    },
    [grouped],
  );
  const expanded = useMemo(() => {
    const keys = new Set<string>();
    for (const m of roots) {
      if (m.kind !== "module" || collapsed.has(m.key)) continue;
      keys.add(m.key);
      if (grouped)
        for (const g of groupBy(m.endpoints, (e) => e.file)) {
          const key = `file:${m.name}:${g.key}`;
          if (!collapsed.has(key)) keys.add(key);
        }
    }
    return keys;
  }, [roots, collapsed, grouped]);

  // "Show in Endpoints": reveal the chosen endpoint once it is in the tree.
  useEffect(() => {
    if (!selectedId || !endpoints.some((e) => e.id === selectedId)) return;
    const t = setTimeout(() => {
      tree.current?.reveal(selectedId);
      useEndpointsView.setState({ currentId: selectedId });
      selectEndpoint(null);
    }, 0);
    return () => clearTimeout(t);
  }, [selectedId, endpoints, grouped]);

  const renderNode = (n: Node, _state: TreeRowState) => {
    if (n.kind === "module")
      return (
        <span className={styles.groupRow}>
          <Icon name="module" size={16} className={styles.groupIcon} />
          <span className={styles.groupName}>{n.name}</span>
          <span className={styles.count}>{count(n.endpoints.length)}</span>
        </span>
      );
    if (n.kind === "file")
      return (
        <span className={styles.groupRow}>
          <Icon name="file" size={16} className={styles.groupIcon} />
          <span className={styles.groupName}>{basename(n.group.key)}</span>
          <span className={styles.count}>{count(n.group.endpoints.length)}</span>
        </span>
      );
    return <EndpointRow endpoint={n.endpoint} />;
  };

  const empty = error ? (
    <EmptyState icon="toolwindow-endpoints" title="Endpoints unavailable">
      {error}
    </EmptyState>
  ) : loading || !loaded ? (
    <div className={styles.loading}>
      <Spinner size={14} /> <T>Reading endpoints…</T>
    </div>
  ) : !available ? (
    <EmptyState icon="toolwindow-endpoints" title="No endpoints in this project">
      <T>No supported web framework was found.</T>
    </EmptyState>
  ) : all.length ? (
    <EmptyState icon="toolwindow-endpoints" title="No endpoints match the filters" />
  ) : (
    <EmptyState icon="toolwindow-endpoints" title="No endpoints found" />
  );

  return (
    <div className={styles.view}>
      <FilterBar />
      <SearchBar />
      <div className={styles.body}>
        <SplitGroup orientation="vertical" id="endpoints-details-split">
          <SplitPanel id="endpoints" minSize={120} className={styles.panel}>
            <Tree<Node>
              handleRef={tree}
              roots={roots}
              getKey={(n) => n.key}
              getLabel={(n) =>
                n.kind === "module"
                  ? n.name
                  : n.kind === "file"
                    ? basename(n.group.key)
                    : `${n.endpoint.path} ${n.endpoint.method}`
              }
              getChildren={getChildren}
              isExpandable={(n) => n.kind !== "endpoint"}
              expanded={expanded}
              onExpandedChange={(_next, node, isExpanded) =>
                useEndpointsView.setState((s) => {
                  const c = new Set(s.collapsed);
                  if (isExpanded) c.delete(node.key);
                  else c.add(node.key);
                  return { collapsed: c };
                })
              }
              renderNode={renderNode}
              onActivate={(n) => {
                if (n.kind === "endpoint") openEndpoint(n.endpoint, true);
              }}
              onSelectionChange={(_sel, node) => {
                if (node?.kind !== "endpoint") return;
                useEndpointsView.setState({ currentId: node.endpoint.id });
                if (useEndpointsViewOptions.getState().autoscroll) openEndpoint(node.endpoint, false);
              }}
              activateExpandable={false}
              multiSelect={false}
              aria-label="Endpoints"
              empty={empty}
            />
          </SplitPanel>
          {details && (
            <>
              <SplitHandle />
              <SplitPanel id="details" minSize={120} defaultSize="40%" className={styles.panel}>
                <DetailsPane endpoint={current} />
              </SplitPanel>
            </>
          )}
        </SplitGroup>
      </div>
      {showDiagnostics && <Diagnostics />}
    </div>
  );
}
