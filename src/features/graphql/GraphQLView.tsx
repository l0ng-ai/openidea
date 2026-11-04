/**
 * GraphQL tool window (IDEA's): "Schemas and Project Structure" lists each schema
 * with its discovery summary, the errors the language server reports for its
 * files and its endpoints; "Query Result" shows the last query's response.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Diagnostic } from "@/bindings";
import { diagnosticsFor, subscribeDiagnostics } from "@/editor/lsp/diagnostics";
import { highlightInto } from "@/editor/lsp/markdown";
import { formatMessage, useTx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { basename, relativeDir, useProject } from "@/platform/project";
import { EmptyState, Icon, IconButton, Spinner, Tabs, Tree, fileIconName, T } from "@/ui";
import { editorService } from "@/workbench/contributions";
import {
  childNodes,
  formatBody,
  formatSize,
  projectNodes,
  responseErrorCount,
  schemaProblems,
  schemaStats,
  type SchemaNode,
} from "./model";
import { configurationFor, discoverSchemasNow, openConfiguration, useGraphQL, type GraphQLTab } from "./store";
import styles from "./GraphQL.module.css";

const HELP_URL = "https://the-guild.dev/graphql/config/docs/user/usage";

export function GraphQLTabs() {
  const tab = useGraphQL((s) => s.tab);
  return (
    <Tabs
      variant="compact"
      aria-label="GraphQL views"
      className={styles.tabs}
      activeId={tab}
      onSelect={(id) => useGraphQL.setState({ tab: id as GraphQLTab })}
      items={[
        { id: "schemas", label: "Schemas and Project Structure" },
        { id: "result", label: "Query Result" },
      ]}
    />
  );
}

export function GraphQLView() {
  const tab = useGraphQL((s) => s.tab);
  return tab === "result" ? <QueryResultView /> : <SchemasView />;
}

function expandableKeys(nodes: readonly SchemaNode[], children: (n: SchemaNode) => SchemaNode[] | undefined): string[] {
  return nodes.flatMap((n) => {
    const c = children(n);
    return c?.length ? [n.key, ...expandableKeys(c, children)] : [];
  });
}

type DiagnosticsByPath = ReadonlyMap<string, readonly Diagnostic[]>;

function readDiagnostics(paths: readonly string[]): DiagnosticsByPath {
  return new Map(paths.map((p) => [p, diagnosticsFor(p)]));
}

/** Diagnostics of `paths`, updated as the language server reports them. */
function useDiagnostics(paths: readonly string[]): DiagnosticsByPath {
  const [diagnostics, setDiagnostics] = useState(() => readDiagnostics(paths));
  useEffect(() => {
    const update = () => setDiagnostics(readDiagnostics(paths));
    update();
    const offs = paths.map((p) => subscribeDiagnostics(p, update));
    return () => offs.forEach((off) => off());
  }, [paths]);
  return diagnostics;
}

function SchemasView() {
  const tx = useTx();
  const root = useProject((s) => s.project?.root ?? "");
  const projects = useGraphQL((s) => s.projects);
  const discovering = useGraphQL((s) => s.discovering);
  const expanded = useGraphQL((s) => s.expanded);

  useEffect(() => {
    if (root && !projects && !discovering) void discoverSchemasNow();
  }, [root, projects, discovering]);

  const paths = useMemo(() => (projects ?? []).flatMap((p) => p.files.map((f) => f.path)), [projects]);
  const diagnostics = useDiagnostics(paths);
  const problemsOf = useCallback((path: string) => diagnostics.get(path) ?? [], [diagnostics]);
  const children = useCallback((n: SchemaNode) => childNodes(n, problemsOf), [problemsOf]);
  const roots = useMemo(() => projectNodes(projects ?? []), [projects]);
  // IDEA opens each schema with its errors and endpoints.
  const defaultExpanded = useMemo(
    () => new Set(roots.flatMap((n) => [n.key, `${n.key}#errors`, `${n.key}#endpoints`])),
    [roots],
  );
  const effectiveExpanded = expanded ?? defaultExpanded;

  const renderNode = (n: SchemaNode) => {
    switch (n.kind) {
      case "project": {
        const p = n.project;
        return (
          <span className={styles.row}>
            <Icon name={p.configPath ? fileIconName(basename(p.configPath)) : "file-graphql"} size={16} />
            <span className={styles.label}>{p.configPath ? basename(p.root) : tx("Default project-wide schema")}</span>
            <span className={styles.muted}>{p.root}</span>
          </span>
        );
      }
      case "summary": {
        const p = n.project;
        const detail = p.dynamic
          ? tx("the configuration is code and is not evaluated")
          : !p.files.length && !p.remote.length
            ? tx("schema is empty")
            : formatMessage(tx("{types} types, {inputs} inputs, {enums} enums, {directives} directives"), {
                ...schemaStats(p),
              });
        return (
          <span className={styles.row}>
            <Icon name="text" size={16} />
            <span className={styles.label}>{tx("Schema discovery summary")}</span>
            <span className={styles.muted}>- {detail}</span>
          </span>
        );
      }
      case "file":
        return (
          <span className={styles.row}>
            <Icon name={fileIconName(basename(n.file.path))} size={16} />
            <span className={styles.label}>{basename(n.file.path)}</span>
            <span className={styles.muted}>{relativeDir(root, n.file.path)}</span>
          </span>
        );
      case "remote":
        return (
          <span className={styles.row}>
            <Icon name="web" size={16} />
            <span className={styles.label}>{n.url}</span>
          </span>
        );
      case "errors": {
        const count = schemaProblems(n.project, problemsOf).length;
        return (
          <span className={styles.row}>
            <Icon name="folder" size={16} />
            <span className={styles.label}>{tx("Schema errors")}</span>
            {count > 0 && <span className={styles.muted}>{count}</span>}
          </span>
        );
      }
      case "error": {
        const d = n.diagnostic;
        return (
          <span className={styles.row}>
            <Icon name={d.severity === "error" ? "error" : "warning"} size={16} />
            <span className={styles.label}>{d.message}</span>
            <span className={styles.muted}>
              {basename(n.path)}:{d.range.start.line + 1}
            </span>
          </span>
        );
      }
      case "noErrors":
        return (
          <span className={styles.row}>
            <Icon name="check" size={16} className={styles.ok} />
            <span className={styles.label}>{tx("No errors found")}</span>
          </span>
        );
      case "endpoints":
        return (
          <span className={styles.row}>
            <Icon name="folder" size={16} />
            <span className={styles.label}>{tx("Endpoints")}</span>
          </span>
        );
      case "endpoint":
        return (
          <span className={styles.row}>
            <span className={styles.label}>{n.endpoint.name}</span>
            <span className={styles.muted}>{n.endpoint.url}</span>
          </span>
        );
      case "noEndpoints":
        return (
          <span className={styles.row}>
            <Icon name="info" size={16} />
            <span className={styles.label}>
              {n.project.configPath
                ? tx("No endpoints available in this schema")
                : tx("No endpoints available in the default schema")}
            </span>
          </span>
        );
    }
  };

  const labelOf = (n: SchemaNode): string => {
    switch (n.kind) {
      case "project":
        return n.project.configPath ? basename(n.project.root) : tx("Default project-wide schema");
      case "summary":
        return tx("Schema discovery summary");
      case "file":
        return basename(n.file.path);
      case "remote":
        return n.url;
      case "errors":
        return tx("Schema errors");
      case "error":
        return n.diagnostic.message;
      case "noErrors":
        return tx("No errors found");
      case "endpoints":
        return tx("Endpoints");
      case "endpoint":
        return n.endpoint.name;
      case "noEndpoints":
        return tx("No endpoints available in the default schema");
    }
  };

  return (
    <div className={styles.view}>
      <div className={styles.toolbar} role="toolbar" aria-orientation="vertical" aria-label={tx("GraphQL actions")}>
        <IconButton icon="plus" size="small" iconSize={16} action="graphql.addConfiguration" />
        <span className={styles.toolbarSep} />
        <IconButton
          icon="settings"
          size="small"
          iconSize={16}
          title="Open Configuration File"
          disabled={!configurationFor(projects)}
          onClick={() => void openConfiguration()}
        />
        <IconButton
          icon="refresh"
          size="small"
          iconSize={16}
          action="graphql.restartDiscovery"
          disabled={discovering}
        />
        <IconButton
          icon="help"
          size="small"
          iconSize={16}
          title="Help"
          onClick={() => void openExternalUrl(HELP_URL)}
        />
        <span className={styles.toolbarSep} />
        <IconButton
          icon="expand-all"
          size="small"
          iconSize={16}
          title="Expand All"
          disabled={!roots.length}
          onClick={() => useGraphQL.setState({ expanded: new Set(expandableKeys(roots, children)) })}
        />
        <IconButton
          icon="collapse-all"
          size="small"
          iconSize={16}
          title="Collapse All"
          disabled={!roots.length}
          onClick={() => useGraphQL.setState({ expanded: new Set() })}
        />
      </div>
      <div className={styles.body}>
        {!projects ? (
          <div className={styles.status} role="status">
            <Spinner size={12} /> <T>Discovering GraphQL schemas</T>…
          </div>
        ) : (
          <Tree<SchemaNode>
            aria-label="GraphQL schemas"
            className={styles.tree}
            roots={roots}
            getKey={(n) => n.key}
            getLabel={labelOf}
            getChildren={children}
            isExpandable={(n) => !!children(n)?.length}
            expanded={effectiveExpanded}
            onExpandedChange={(next) => useGraphQL.setState({ expanded: next })}
            renderNode={renderNode}
            multiSelect={false}
            onActivate={(n) => {
              if (n.kind === "project" && n.project.configPath) void editorService().openFile(n.project.configPath);
              else if (n.kind === "file") void editorService().openFile(n.file.path);
              else if (n.kind === "error") {
                const { start } = n.diagnostic.range;
                void editorService().openFile(n.path, { selection: { line: start.line, col: start.col } });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function QueryResultView() {
  const tx = useTx();
  const result = useGraphQL((s) => s.result);
  const running = useGraphQL((s) => s.running !== null);
  if (!result) {
    return (
      <EmptyState title={running ? "Running GraphQL query" : "No query results"}>
        {!running && (
          <span>
            <T>Run a query with Execute GraphQL in the toolbar of a GraphQL file.</T>
          </span>
        )}
      </EmptyState>
    );
  }
  const errors = responseErrorCount(result.body);
  const failed = !!result.error || errors > 0 || (result.status !== null && result.status >= 400);
  const ms = result.totalMs === null ? "?" : Math.round(result.totalMs);
  const size = formatSize(result.size ?? result.body?.length ?? 0);
  return (
    <div className={styles.result}>
      <div className={styles.resultHeader} title={`${result.endpoint.name} - ${result.endpoint.url}`}>
        {running ? (
          <Spinner size={12} />
        ) : failed ? (
          <span className={styles.dotFailed} aria-hidden />
        ) : (
          <Icon name="check" size={16} className={styles.ok} />
        )}
        <span className={styles.label}>
          {result.error
            ? formatMessage(tx("{name}: {error}"), { name: basename(result.path), error: result.error })
            : formatMessage(tx("{file}: {ms} ms execution time, {size} response"), {
                file: basename(result.path),
                ms,
                size,
              })}
          {!result.error && errors === 1 && tx(", 1 error")}
          {!result.error && errors > 1 && formatMessage(tx(", {count} errors"), { count: errors })}
        </span>
      </div>
      <ResultBody text={result.error ?? formatBody(result.body)} json={!result.error} />
    </div>
  );
}

/** The response in the editor's colours (JSON), like IDEA's result viewer. */
function ResultBody({ text, json }: { text: string; json: boolean }) {
  const tx = useTx();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    if (json) void highlightInto(el, text, "JSON");
  }, [text, json]);
  const lines = text.split("\n").length;
  return (
    <div className={styles.outputBox}>
      <div className={styles.outputGutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre ref={ref} className={styles.output} aria-label={tx("Query result")} />
    </div>
  );
}
