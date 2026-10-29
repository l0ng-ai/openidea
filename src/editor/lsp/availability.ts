/**
 * Per-document, per-feature back-off after `unavailable` errors, so background
 * features (completion while typing, lightbulb, inlay hints…) don't hammer the
 * backend for files without a language server, or for a feature the server
 * doesn't offer. Each feature owns its back-off: a server lacking one
 * capability (Godot has no inlay hints, say) must not switch off the others.
 * All of them are cleared when any server becomes ready.
 */
import { isTauri, onIdeEvent } from "@/platform/ipc";
import type { LspRefreshKind } from "@/bindings";

const DEFAULT_BACKOFF_MS = 15_000;
const all = new Set<Map<number, number>>();

export interface FeatureBackoff {
  /** Stop asking about `doc` for a while. */
  mark(doc: number): void;
  /** Whether `doc` is still being left alone. */
  active(doc: number): boolean;
}

/** A back-off for one feature; give each feature its own. */
export function featureBackoff(ms = DEFAULT_BACKOFF_MS): FeatureBackoff {
  const until = new Map<number, number>();
  all.add(until);
  return {
    mark(doc) {
      until.set(doc, Date.now() + ms);
    },
    active(doc) {
      const t = until.get(doc);
      if (t === undefined) return false;
      if (t > Date.now()) return true;
      until.delete(doc);
      return false;
    },
  };
}

function clearBackoffs() {
  for (const until of all) until.clear();
}

/**
 * Calls `fn` when data of `kind` fetched earlier may be stale: the server asked
 * for a refresh (`workspace/inlayHint/refresh`…, e.g. after indexing) or it
 * has just (re)started, so requests made while it was down came back empty.
 */
export function onLspRefresh(kind: LspRefreshKind, fn: () => void): () => void {
  if (!isTauri()) return () => {};
  const starting = new Set<number>();
  const offRefresh = onIdeEvent("lspRefresh", (e) => {
    if (e.kind === kind) fn();
  });
  const offStatus = onIdeEvent("languageServer", (e) => {
    if (e.status === "starting") starting.add(e.server);
    else if (e.status === "ready" && starting.delete(e.server)) fn();
  });
  return () => {
    offRefresh();
    offStatus();
  };
}

/** A busy spell at least this long is indexing / a build, not the server answering a request. */
const LONG_BUSY_MS = 1500;

/** A busy spell starting this soon after `fn` ran may be `fn`'s own requests. */
const ECHO_MS = 2000;

/**
 * Calls `fn` when a server becomes ready after starting or after a long busy
 * spell (indexing), when earlier answers may have been incomplete. Short busy
 * spells are ignored: jdtls reports progress for the very requests a caller
 * sends, and re-asking on each of them would never stop. For the same reason
 * a long spell that began right after `fn` ran (slow requests `fn` sent, or
 * indexing right after start) re-runs it only once in a row.
 */
export function onServerSettled(fn: () => void): () => void {
  if (!isTauri()) return () => {};
  const since = new Map<number, number>();
  const fired = new Map<number, { at: number; echoed: boolean }>();
  return onIdeEvent("languageServer", (e) => {
    if (e.status === "starting") {
      since.set(e.server, -Infinity);
      fired.delete(e.server);
    } else if (e.status === "busy") {
      if (!since.has(e.server)) since.set(e.server, Date.now());
    } else if (e.status === "ready") {
      const t = since.get(e.server);
      since.delete(e.server);
      if (t === undefined || Date.now() - t < LONG_BUSY_MS) return;
      const last = fired.get(e.server);
      const echo = !!last && t - last.at < ECHO_MS;
      if (echo && last.echoed) return;
      fired.set(e.server, { at: Date.now(), echoed: echo });
      fn();
    } else since.delete(e.server);
  });
}

export function installAvailabilityEvents(): () => void {
  return onIdeEvent("languageServer", (e) => {
    if (e.status === "ready") clearBackoffs();
  });
}
