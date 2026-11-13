/**
 * HTTP Client tool window: the response history (left) and the selected
 * exchange (right): status line, timing, body (pretty-printed JSON / XML /
 * HTML or raw), response headers and the request as sent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { HttpExchange, HttpHistoryEntry } from "@/platform/ipc";
import {
  Button,
  EmptyState,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  T,
  useSelectionBoundary,
} from "@/ui";
import { bodyKind, formatMs, formatSize, prettyBody } from "./format";
import { cancelRunning, clearHistory, refreshHistory, selectEntry, useHttpClient } from "./store";
import styles from "./HttpClient.module.css";
import { tx } from "@/platform/i18n";

function statusTone(status: number | null | undefined): string {
  if (status == null) return styles.statusError ?? "";
  if (status >= 500 || status >= 400) return styles.statusError ?? "";
  if (status >= 300) return styles.statusRedirect ?? "";
  return styles.statusOk ?? "";
}

function time(ms: number | null): string {
  return new Date(ms ?? 0).toLocaleTimeString();
}

function EntryRow({ entry, selected }: { entry: HttpHistoryEntry; selected: boolean }) {
  return (
    <button
      type="button"
      className={clsx(styles.entry, selected && styles.entrySelected)}
      onClick={() => void selectEntry(entry.id)}
      title={entry.error ?? entry.url}
    >
      <span className={clsx(styles.status, statusTone(entry.status))}>{entry.status ?? "ERR"}</span>
      <span className={styles.method}>{entry.method}</span>
      <span className={styles.url}>{entry.name ?? entry.url}</span>
      <span className={styles.when}>{time(entry.timeMs)}</span>
    </button>
  );
}

type Tab = "body" | "headers" | "request";

function ExchangeView({ ex }: { ex: HttpExchange }) {
  const [tab, setTab] = useState<Tab>("body");
  const pane = useRef<HTMLDivElement>(null);
  useSelectionBoundary(pane);
  const [raw, setRaw] = useState(false);
  const r = ex.response;
  const kind = r?.body != null ? bodyKind(r.contentType, r.body) : "text";
  const body = useMemo(() => (r?.body == null ? null : raw ? r.body : prettyBody(kind, r.body)), [r, raw, kind]);
  return (
    <div className={styles.exchange}>
      <div className={styles.statusLine}>
        {r ? (
          <>
            <span className={clsx(styles.status, statusTone(r.status))}>
              {r.status} {r.statusText}
            </span>
            <span className={styles.meta}>{r.version}</span>
            <span className={styles.meta} title={`Headers after ${formatMs(r.ttfbMs)}`}>
              {formatMs(r.totalMs)}
            </span>
            <span className={styles.meta}>{formatSize(r.size)}</span>
          </>
        ) : (
          <span className={clsx(styles.status, styles.statusError)}>{ex.entry.error ?? "No response"}</span>
        )}
        <span className={styles.requestLine}>
          {ex.request.method} {ex.request.url}
        </span>
      </div>
      <Tabs
        variant="compact"
        activeId={tab}
        onSelect={(id) => setTab(id as Tab)}
        items={[
          { id: "body", label: "Response" },
          { id: "headers", label: r ? tx`Headers (${r.headers.length})` : "Headers" },
          { id: "request", label: "Request" },
        ]}
        trailing={
          tab === "body" && kind !== "text" ? (
            <IconButton
              icon="soft-wrap"
              title={raw ? "Show Formatted" : "Show Raw"}
              pressed={raw}
              onClick={() => setRaw((v) => !v)}
            />
          ) : undefined
        }
      />
      {/* Focusable, so Select All and Copy work on the response like in a read-only editor. */}
      <div ref={pane} className={styles.tabBody} tabIndex={0}>
        {tab === "body" &&
          (r == null ? (
            <pre className={styles.pre}>{ex.entry.error}</pre>
          ) : body == null ? (
            <EmptyState title="Binary response">
              {r.contentType ?? tx("unknown type")}, {formatSize(r.size)}
            </EmptyState>
          ) : (
            <pre className={styles.pre} aria-label={tx("Response body")}>
              {body}
              {r.truncated && (
                <span className={styles.truncated}>{`\n… truncated (${formatSize(r.size)} received)`}</span>
              )}
            </pre>
          ))}
        {tab === "headers" && r && <HeaderTable headers={r.headers} />}
        {tab === "request" && (
          <pre className={styles.pre}>
            {`${ex.request.method} ${ex.request.url}\n`}
            {ex.request.headers.map(([k, v]) => `${k}: ${v}\n`).join("")}
            {ex.request.body != null ? `\n${ex.request.body}` : ""}
          </pre>
        )}
      </div>
    </div>
  );
}

function HeaderTable({ headers }: { headers: Array<[string, string]> }) {
  return (
    <table className={styles.headers}>
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HttpClientView() {
  const history = useHttpClient((s) => s.history);
  const selected = useHttpClient((s) => s.selected);
  const exchange = useHttpClient((s) => (s.selected ? s.exchanges[s.selected] : undefined));
  const running = useHttpClient((s) => s.running);
  useEffect(() => {
    void refreshHistory();
  }, []);
  return (
    <SplitGroup orientation="horizontal" className={styles.root}>
      <SplitPanel id="http-history" defaultSize="32%" minSize="160px">
        <div className={styles.list} role="list" aria-label={tx("Response history")}>
          {running && (
            <div className={styles.runningRow}>
              <Spinner size={12} /> {tx`Sending request #${running.index + 1}…`}
            </div>
          )}
          {history.length === 0 && !running ? (
            <EmptyState title="No requests yet">
              <T>Run a request from an .http file with the gutter ▶ or ⌘↩.</T>
            </EmptyState>
          ) : (
            history.map((h) => <EntryRow key={h.id} entry={h} selected={h.id === selected} />)
          )}
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="http-response" minSize="200px">
        {running ? (
          <div className={styles.pending} role="status">
            <div className={styles.pendingLine}>
              <Spinner size={12} /> {tx`Sending request #${running.index + 1}…`}
            </div>
            {running.method && (
              <div className={styles.pendingRequest}>
                <span className={styles.pendingMethod}>{running.method}</span> {running.url}
              </div>
            )}
            <div>
              <Button onClick={cancelRunning}>
                <T>Stop Request</T>
              </Button>
            </div>
          </div>
        ) : exchange ? (
          <ExchangeView key={exchange.entry.id} ex={exchange} />
        ) : selected ? (
          <div className={styles.center}>
            <Spinner />
          </div>
        ) : (
          <EmptyState title="No response selected" />
        )}
      </SplitPanel>
    </SplitGroup>
  );
}

export function HttpClientHeaderActions() {
  const running = useHttpClient((s) => !!s.running);
  return (
    <>
      <IconButton icon="stop" title="Stop Request" disabled={!running} onClick={cancelRunning} />
      <IconButton icon="refresh" title="Reload History" onClick={() => void refreshHistory()} />
      <IconButton icon="trash" title="Clear History" onClick={() => void clearHistory()} />
    </>
  );
}
