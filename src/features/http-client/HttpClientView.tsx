/**
 * HTTP Client tool window: the response history (left) and the selected
 * exchange (right): status line, timing, body (pretty-printed JSON / XML /
 * HTML or raw), response headers and the request as sent.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
import { ConsoleFindBar } from "@/ui/ConsoleFindBar";
import { DEFAULT_FIND_OPTIONS, findInLines, type ConsoleMatch, type FindOptions } from "@/ui/consoleFind";
import { formatBinding, hasPrimaryModifier, hostBinding } from "@/platform/keymap";
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
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [active, setActive] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const searchable = findOpen && tab === "body" && body != null;
  const lines = useMemo(() => (body ?? "").split("\n").map((text, id) => ({ id, text })), [body]);
  const found = useMemo(
    () => (searchable ? findInLines(lines, query, findOptions) : { matches: [], overflow: false, invalid: false }),
    [searchable, lines, query, findOptions],
  );
  const activeIndex = found.matches.length ? Math.min(active, found.matches.length - 1) : -1;
  useEffect(() => {
    pane.current?.querySelector("[data-find-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex, found]);
  const openFind = () => {
    setFindOpen(true);
    // The bar mounts with this render; focus it (and select the query) once it has.
    requestAnimationFrame(() => findInput.current?.select());
  };
  const closeFind = () => {
    setFindOpen(false);
    pane.current?.focus();
  };
  const goToMatch = (step: number) => {
    const n = found.matches.length;
    if (n) setActive((activeIndex + step + n) % n);
  };
  // ⌘F in the response, as in IDEA's response viewer: the find bar of the Run console.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (
      tab === "body" &&
      body != null &&
      e.key.toLowerCase() === "f" &&
      hasPrimaryModifier(e) &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      openFind();
    }
  };
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
          tab === "body" && body != null ? (
            <>
              <IconButton
                icon="search"
                title="Find…"
                shortcut={formatBinding(hostBinding("Meta+F"))}
                pressed={findOpen}
                onClick={() => (findOpen ? closeFind() : openFind())}
              />
              {kind !== "text" && (
                <IconButton
                  icon="soft-wrap"
                  title={raw ? "Show Formatted" : "Show Raw"}
                  pressed={raw}
                  onClick={() => setRaw((v) => !v)}
                />
              )}
            </>
          ) : undefined
        }
      />
      {searchable && (
        <ConsoleFindBar
          query={query}
          onChange={(q) => {
            setQuery(q);
            setActive(0);
          }}
          options={findOptions}
          onOptionsChange={(o) => {
            setFindOptions(o);
            setActive(0);
          }}
          count={found.matches.length}
          active={activeIndex}
          overflow={found.overflow}
          invalid={found.invalid}
          inputRef={findInput}
          onNext={() => goToMatch(1)}
          onPrevious={() => goToMatch(-1)}
          onClose={closeFind}
          label="Find in response"
        />
      )}
      {/* Focusable, so Select All and Copy work on the response like in a read-only editor. */}
      <div ref={pane} className={styles.tabBody} tabIndex={0} onKeyDown={onKeyDown}>
        {tab === "body" &&
          (r == null ? (
            <pre className={styles.pre}>{ex.entry.error}</pre>
          ) : body == null ? (
            <EmptyState title="Binary response">
              {r.contentType ?? tx("unknown type")}, {formatSize(r.size)}
            </EmptyState>
          ) : (
            <pre className={styles.pre} aria-label={tx("Response body")}>
              {found.matches.length ? highlighted(lines, found.matches, activeIndex) : body}
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

/** The body with its find matches marked, the current one distinctly. */
function highlighted(lines: readonly { text: string }[], matches: readonly ConsoleMatch[], current: number): ReactNode {
  const out: ReactNode[] = [];
  let m = 0;
  lines.forEach(({ text }, line) => {
    if (line > 0) out.push("\n");
    let at = 0;
    for (; m < matches.length && matches[m]!.line === line; m++) {
      const { start, end } = matches[m]!;
      if (start > at) out.push(text.slice(at, start));
      out.push(
        <mark
          key={m}
          className={clsx(styles.match, m === current && styles.matchCurrent)}
          data-find-current={m === current ? "" : undefined}
        >
          {text.slice(start, end)}
        </mark>,
      );
      at = end;
    }
    if (at < text.length) out.push(text.slice(at));
  });
  return <Fragment>{out}</Fragment>;
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
    <SplitGroup orientation="horizontal" className={styles.root} storageKey="openidea.httpClient.split">
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
