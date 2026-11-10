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

/** A busy spell starting this soon after a start is the server loading the project. */
const LOADING_AFTER_START_MS = 5000;

type Settle = (server: number, spellStart: number, loading: boolean) => void;

/** Servers starting (`-Infinity`) or busy since when. */
const spells = new Map<number, number>();
/** When servers became ready after starting, until their next spell ends. */
const readyAfterStart = new Map<number, number>();
const settles = new Set<Settle>();
let tracking = false;

/**
 * Follows every server's spells from app start, so an editor that mounts while its
 * server starts or loads (one restored at launch) still learns when that ends.
 */
function trackSpells() {
  if (tracking || !isTauri()) return;
  tracking = true;
  onIdeEvent("languageServer", (e) => {
    if (e.status === "starting") {
      spells.set(e.server, -Infinity);
      readyAfterStart.delete(e.server);
    } else if (e.status === "busy") {
      if (!spells.has(e.server)) spells.set(e.server, Date.now());
    } else if (e.status === "ready") {
      const t = spells.get(e.server);
      spells.delete(e.server);
      if (t === undefined) return;
      const startedAt = readyAfterStart.get(e.server);
      if (t === -Infinity) readyAfterStart.set(e.server, Date.now());
      else readyAfterStart.delete(e.server);
      const loading = startedAt !== undefined && t - startedAt < LOADING_AFTER_START_MS;
      for (const settle of settles) settle(e.server, t, loading);
    } else {
      spells.delete(e.server);
      readyAfterStart.delete(e.server);
    }
  });
}

/**
 * Calls `fn` when a server becomes ready after starting or after a long busy
 * spell (indexing), when earlier answers may have been incomplete. Short busy
 * spells are ignored: jdtls reports progress for the very requests a caller
 * sends, and re-asking on each of them would never stop. For the same reason
 * a long spell that began right after `fn` ran (slow requests `fn` sent, or
 * indexing right after start) re-runs it only once in a row. The spell right
 * after a start counts whatever its length: it is the project loading (vtsls
 * loads a small one in about a second), and answers given meanwhile are partial.
 */
export function onServerSettled(fn: () => void): () => void {
  if (!isTauri()) return () => {};
  trackSpells();
  const fired = new Map<number, { at: number; echoed: boolean }>();
  const settle: Settle = (server, t, loading) => {
    if (!loading && Date.now() - t < LONG_BUSY_MS) return;
    const last = fired.get(server);
    const echo = !!last && t - last.at < ECHO_MS;
    if (echo && last.echoed) return;
    fired.set(server, { at: Date.now(), echoed: echo });
    fn();
  };
  settles.add(settle);
  const offStarting = onIdeEvent("languageServer", (e) => {
    if (e.status === "starting") fired.delete(e.server);
  });
  return () => {
    settles.delete(settle);
    offStarting();
  };
}

export function installAvailabilityEvents(): () => void {
  trackSpells();
  return onIdeEvent("languageServer", (e) => {
    if (e.status === "ready") clearBackoffs();
  });
}
