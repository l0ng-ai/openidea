import { memo, useEffect, useMemo, useState } from "react";
import { useTx } from "@/platform/i18n";
import { call, commands, type JsResponseBody } from "@/platform/ipc";
import { Button, Checkbox, IconButton, Input, T } from "@/ui";
import { addRequestBreakpoint } from "./eventBreakpoints";
import {
  clearNetwork,
  filterRows,
  NETWORK_CATEGORIES,
  useJsNetwork,
  type NetworkCategory,
  type NetworkRow,
} from "./network";
import { OverridesDialog, type OverrideDraft } from "./OverridesDialog";
import { useRefused } from "./refusals";
import { answeredBy, useResponseOverrides } from "./responseOverrides";
import styles from "./Network.module.css";

const NO_ROWS: NetworkRow[] = [];

/** What a request breakpoint looks for to stop at the next request like `url`: its path. */
export function requestPattern(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1000) return `${bytes} B`;
  return bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} kB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

const Row = memo(function Row({
  row,
  selected,
  overridden,
  onSelect,
}: {
  row: NetworkRow;
  selected: boolean;
  /** A response override applies to requests to this URL. */
  overridden: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      role="row"
      aria-selected={selected}
      className={`${styles.row} ${selected ? styles.selected : ""} ${row.error ? styles.failed : ""}`}
      onClick={() => onSelect(row.key)}
      title={row.url}
    >
      <span role="cell" className={styles.name}>
        {row.name}
      </span>
      <span role="cell">
        {row.error ?? row.status ?? ""}
        {overridden && (
          <span className={styles.badge}>
            <T>overridden</T>
          </span>
        )}
      </span>
      <span role="cell">{row.method}</span>
      <span role="cell">{row.type}</span>
      <span role="cell" className={styles.number}>
        {formatSize(row.size)}
      </span>
      <span role="cell" className={styles.number}>
        {formatDuration(row.durationMs)}
      </span>
    </div>
  );
});

function Headers({ title, headers }: { title: string; headers: Record<string, string> }) {
  const names = Object.keys(headers).sort((a, b) => a.localeCompare(b));
  if (!names.length) return null;
  return (
    <>
      <div className={styles.sectionTitle}>{title}</div>
      {names.map((name) => (
        <div key={name} className={styles.header}>
          <span className={styles.headerName}>{name}</span>
          <span className={styles.headerValue}>{headers[name]}</span>
        </div>
      ))}
    </>
  );
}

type Body = { state: "loading" } | { state: "gone" } | { state: "loaded"; body: JsResponseBody };

/** The body of one finished request; mounted per request (`key`), so it starts out loading. */
function ResponseBody({ session, requestId }: { session: number; requestId: string }) {
  const [body, setBody] = useState<Body>({ state: "loading" });
  useEffect(() => {
    let current = true;
    call(commands.debugJsResponseBody(session, requestId)).then(
      (loaded) => current && setBody({ state: "loaded", body: loaded }),
      // The session ended, or the browser no longer keeps the response.
      () => current && setBody({ state: "gone" }),
    );
    return () => {
      current = false;
    };
  }, [session, requestId]);
  if (body.state === "loading") return null;
  if (body.state === "gone")
    return (
      <div className={styles.note}>
        <T>Response body is no longer available</T>
      </div>
    );
  if (body.body.base64Encoded)
    return (
      <div className={styles.note}>
        <T>Binary content</T>
      </div>
    );
  return (
    <>
      {body.body.truncated && (
        <div className={styles.note}>
          <T>Showing the first 1 MB</T>
        </div>
      )}
      <pre className={styles.body}>{body.body.body}</pre>
    </>
  );
}

function Detail({
  session,
  row,
  onOverride,
}: {
  session: number;
  row: NetworkRow;
  onOverride: (row: NetworkRow) => void;
}) {
  const tx = useTx();
  return (
    <div className={styles.detail} aria-label={tx("Request details")}>
      <div className={styles.url}>{row.url}</div>
      <div className={styles.summary}>
        {[row.method, row.error ?? row.status, row.mimeType].filter((part) => part != null && part !== "").join(" · ")}
      </div>
      {row.initiator && (
        <div className={styles.summary}>
          {tx("Requested by")} {row.initiator.function || tx("(anonymous)")} — {row.initiator.url}:
          {row.initiator.line + 1}
        </div>
      )}
      <div className={styles.actions}>
        <Button size="small" variant="ghost" onClick={() => addRequestBreakpoint(requestPattern(row.url))}>
          <T>Break on Next Request</T>
        </Button>
        <Button size="small" variant="ghost" onClick={() => onOverride(row)}>
          <T>Override Response…</T>
        </Button>
      </div>
      <Headers title={tx("Request Headers")} headers={row.requestHeaders} />
      <Headers title={tx("Response Headers")} headers={row.responseHeaders} />
      {row.done && !row.error && (
        <>
          <div className={styles.sectionTitle}>{tx("Response")}</div>
          <ResponseBody key={row.key} session={session} requestId={row.requestId} />
        </>
      )}
    </div>
  );
}

/**
 * Loads the page again. Recording starts while the page is already loading, so this is how
 * the document and its first scripts get into the list.
 */
function reloadPage(session: number) {
  void call(commands.debugEvaluateIn(session, null, "location.reload()", "repl")).catch(() => undefined);
}

/** The requests of the page debugged by `session`. */
export function NetworkView({ session }: { session: number }) {
  const tx = useTx();
  const rows = useJsNetwork((s) => s.rows[session] ?? NO_ROWS);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<NetworkCategory | "all">("all");
  const [mine, setMine] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const shown = useMemo(() => filterRows(rows, query, category, mine), [rows, query, category, mine]);
  const selected = rows.find((r) => r.key === selectedKey) ?? null;
  const notReported = useRefused(session, "network") != null;
  const overrides = useResponseOverrides((s) => s.rules);
  const overridesOn = overrides.filter((r) => r.enabled).length;
  const notReplaced = useRefused(session, "overrides");
  // The override editor: open on the list (`draft` null) or on a request's response.
  const [editing, setEditing] = useState<{ draft: OverrideDraft | null } | null>(null);
  const overrideResponse = async (row: NetworkRow) => {
    // The request's own body is where the edit starts; one that can't be read as text starts empty.
    const own = await call(commands.debugJsResponseBody(session, row.requestId)).catch(() => null);
    setEditing({
      draft: {
        pattern: requestPattern(row.url),
        status: row.status ?? 200,
        contentType: row.mimeType ?? "application/json",
        body: own && !own.base64Encoded ? own.body : "",
      },
    });
  };
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by URL"
          aria-label="Filter requests"
        />
        <div className={styles.categories} role="group" aria-label={tx("Resource type")}>
          {NETWORK_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`${styles.category} ${category === c.id ? styles.categoryOn : ""}`}
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
            >
              {tx(c.label)}
            </button>
          ))}
        </div>
        <Checkbox checked={mine} onChange={setMine} label="My code only" />
        <Button size="small" variant="ghost" onClick={() => setEditing({ draft: null })}>
          {tx("Overrides")}
          {overridesOn ? ` (${overridesOn})` : ""}
        </Button>
        <IconButton icon="refresh" title="Reload Page" size="small" onClick={() => reloadPage(session)} />
        <IconButton icon="trash" title="Clear" size="small" onClick={() => clearNetwork(session)} />
        <span className={styles.count}>
          {shown.length === rows.length ? rows.length : `${shown.length} / ${rows.length}`}
        </span>
      </div>
      {notReplaced != null && overridesOn > 0 && (
        <div className={styles.refused} role="alert">
          {tx`Responses are not replaced in this page: ${notReplaced}`}
        </div>
      )}
      <div className={styles.split}>
        <div className={styles.table} role="table" aria-label={tx("Requests")}>
          <div role="row" className={styles.head}>
            <span role="columnheader">{tx("Name")}</span>
            <span role="columnheader">{tx("Status")}</span>
            <span role="columnheader">{tx("Method")}</span>
            <span role="columnheader">{tx("Type")}</span>
            <span role="columnheader">{tx("Size")}</span>
            <span role="columnheader">{tx("Time")}</span>
          </div>
          {shown.length === 0 && (
            <div className={styles.note}>
              {rows.length
                ? tx("No request matches the filter")
                : notReported
                  ? tx("This version of the JavaScript debugger does not report a page's requests.")
                  : tx("No requests yet. Reload the page to see the requests of its load.")}
            </div>
          )}
          {shown.map((row) => (
            <Row
              key={row.key}
              row={row}
              selected={row.key === selectedKey}
              overridden={notReplaced == null && answeredBy(row, overrides)}
              onSelect={setSelectedKey}
            />
          ))}
        </div>
        {selected && <Detail session={session} row={selected} onOverride={(row) => void overrideResponse(row)} />}
      </div>
      <OverridesDialog open={editing != null} onClose={() => setEditing(null)} draft={editing?.draft} />
    </div>
  );
}
