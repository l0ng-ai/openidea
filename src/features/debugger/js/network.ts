/**
 * The requests of a debugged page, one row each, built from the browser's events
 * (`DebugEvent::JsNetwork`). Kept per debug session.
 */
import { create } from "zustand";
import type { JsInitiator, JsNetworkEvent } from "@/platform/ipc";

export interface NetworkRow {
  /** Unique among rows; a browser reuses request ids. */
  key: string;
  requestId: string;
  url: string;
  name: string;
  method: string;
  /** `Fetch`, `XHR`, `Script`, `Document`, … */
  type: string;
  status: number | null;
  mimeType: string | null;
  /** Bytes received over the network. */
  size: number | null;
  /** The browser's clock when the request was sent (ms). */
  startedAt: number;
  durationMs: number | null;
  error: string | null;
  /** Finished or failed: later events with this request id belong to another request. */
  done: boolean;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  initiator: JsInitiator | null;
}

/** Rows kept per session; the oldest go first. */
export const MAX_ROWS = 2000;

export const useJsNetwork = create<{ rows: Record<number, NetworkRow[]> }>(() => ({ rows: {} }));

let serial = 0;

/** The end of the URL's path with its query, or the host for the root path. */
export function rowName(url: string): string {
  try {
    const u = new URL(url);
    if (!u.host) return url;
    const last = u.pathname.match(/[^/]+\/?$/)?.[0];
    return last ? last + u.search : u.host;
  } catch {
    return url;
  }
}

function apply(rows: NetworkRow[], e: JsNetworkEvent) {
  let at = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.requestId === e.requestId) {
      at = rows[i]!.done ? -1 : i;
      break;
    }
  }
  if (e.kind === "request") {
    const url = e.url ?? "";
    const started: NetworkRow = {
      key: `${e.requestId}#${serial++}`,
      requestId: e.requestId,
      url,
      name: rowName(url),
      method: e.method ?? "",
      type: e.resourceType ?? "",
      status: null,
      mimeType: null,
      size: null,
      startedAt: e.timestampMs,
      durationMs: null,
      error: null,
      done: false,
      requestHeaders: e.headers,
      responseHeaders: {},
      initiator: e.initiator,
    };
    // Sent again while open: the request was redirected, and goes on under its new URL.
    if (at >= 0) rows[at] = { ...started, key: rows[at]!.key, startedAt: rows[at]!.startedAt };
    else rows.push(started);
    return;
  }
  if (at < 0) return;
  const row = rows[at]!;
  if (e.kind === "response") {
    rows[at] = {
      ...row,
      status: e.status,
      mimeType: e.mimeType,
      type: e.resourceType ?? row.type,
      responseHeaders: e.headers,
    };
  } else {
    rows[at] = {
      ...row,
      done: true,
      durationMs: Math.max(0, e.timestampMs - row.startedAt),
      size: e.kind === "finished" ? e.encodedLength : row.size,
      error: e.kind === "failed" ? (e.errorText ?? "Failed") : null,
    };
  }
}

export function applyNetworkEvents(session: number, events: readonly JsNetworkEvent[]) {
  if (!events.length) return;
  useJsNetwork.setState((s) => {
    const rows = [...(s.rows[session] ?? [])];
    for (const e of events) apply(rows, e);
    return { rows: { ...s.rows, [session]: rows.length > MAX_ROWS ? rows.slice(-MAX_ROWS) : rows } };
  });
}

const pending = new Map<number, JsNetworkEvent[]>();
let flushing: number | null = null;

/** Adds an event; a burst (a page load) reaches the store once per frame. */
export function queueNetworkEvent(session: number, event: JsNetworkEvent) {
  const list = pending.get(session);
  if (list) list.push(event);
  else pending.set(session, [event]);
  // A timer and not an animation frame: those stop while the window is in the background.
  flushing ??= window.setTimeout(() => {
    flushing = null;
    const batches = [...pending];
    pending.clear();
    for (const [id, events] of batches) applyNetworkEvents(id, events);
  }, 50);
}

/** Empties the list; requests still open are forgotten with it. */
export function clearNetwork(session: number) {
  useJsNetwork.setState((s) => ({ rows: { ...s.rows, [session]: [] } }));
}

export function forgetNetwork(session: number) {
  pending.delete(session);
  useJsNetwork.setState((s) => {
    if (!(session in s.rows)) return s;
    const rows = { ...s.rows };
    delete rows[session];
    return { rows };
  });
}

/** The groups a browser's network panel filters by. */
export type NetworkCategory = "fetch" | "doc" | "js" | "css" | "img" | "font" | "other";

export const NETWORK_CATEGORIES: ReadonlyArray<{ id: NetworkCategory | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "fetch", label: "Fetch/XHR" },
  { id: "doc", label: "Doc" },
  { id: "js", label: "JS" },
  { id: "css", label: "CSS" },
  { id: "img", label: "Img" },
  { id: "font", label: "Font" },
  { id: "other", label: "Other" },
];

const CATEGORY_OF: Record<string, NetworkCategory> = {
  Fetch: "fetch",
  XHR: "fetch",
  Document: "doc",
  Script: "js",
  Stylesheet: "css",
  Image: "img",
  Font: "font",
};

/** The group of a browser resource type (`Fetch`, `Script`, …). */
export function rowCategory(type: string): NetworkCategory {
  return CATEGORY_OF[type] ?? "other";
}

/** Whether a script of the project made the request: not a library, and not a tag of the page. */
export function requestedByProject(row: Pick<NetworkRow, "initiator">): boolean {
  return row.initiator != null && !/\/node_modules\//.test(row.initiator.url);
}

/** The rows whose URL contains `query`, of one `category`, and (`mine`) asked for by the project's code. */
export function filterRows(
  rows: readonly NetworkRow[],
  query: string,
  category: NetworkCategory | "all" = "all",
  mine = false,
): NetworkRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!q || r.url.toLowerCase().includes(q)) &&
      (category === "all" || rowCategory(r.type) === category) &&
      (!mine || requestedByProject(r)),
  );
}
