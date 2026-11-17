/**
 * Responses a debugged page gets in place of the server's: "a request whose URL contains
 * this text is answered with this status, content type and body". Kept per project and
 * given to every page session, to try a screen against data the backend doesn't return yet.
 */
import { create } from "zustand";
import { call, commands, type JsResponseRule } from "@/platform/ipc";
import { isLive, isLiveSession, useDebug } from "../state";
import { networkSerial } from "./network";
import { recordRefusal } from "./refusals";

export interface ResponseOverride {
  id: string;
  /** Part of the URL. */
  pattern: string;
  status: number;
  contentType: string;
  body: string;
  enabled: boolean;
}

const PREFIX = "openidea.debugger.jsOverrides:";

export const useResponseOverrides = create<{ root: string | null; rules: ResponseOverride[] }>(() => ({
  root: null,
  rules: [],
}));

/** A status a browser accepts for a response; anything else answers 200. */
const validStatus = (status: number) => (Number.isInteger(status) && status >= 100 && status <= 599 ? status : 200);

function stored(root: string): ResponseOverride[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + root) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return (raw as Array<Partial<ResponseOverride>>)
      .filter((r) => typeof r?.id === "string" && typeof r.pattern === "string")
      .map((r) => ({
        id: r.id!,
        pattern: r.pattern!,
        status: validStatus(Number(r.status)),
        contentType: typeof r.contentType === "string" ? r.contentType : "application/json",
        body: typeof r.body === "string" ? r.body : "",
        enabled: r.enabled !== false,
      }));
  } catch {
    return [];
  }
}

/**
 * The first request (`NetworkRow.seq`) each rule can have answered, for rules added, turned on or
 * pointed at other URLs while pages ran; rules loaded with the project answer from the start.
 */
const since = new Map<string, number>();

export function loadResponseOverrides(root: string | null) {
  since.clear();
  useResponseOverrides.setState({ root, rules: root ? stored(root) : [] });
  void syncResponseOverrides();
}

function change(rules: ResponseOverride[]) {
  useResponseOverrides.setState({ rules });
  const { root } = useResponseOverrides.getState();
  if (root) {
    try {
      localStorage.setItem(PREFIX + root, JSON.stringify(rules));
    } catch {
      // Storage unavailable: the rules last for this session only.
    }
  }
  void syncResponseOverrides();
}

/** Adds a rule, or replaces the one with `rule.id`. Returns the rule's id. */

/** Whether the rule that matches `row` was in force when the page sent it. */
export function answeredBy(row: { url: string; seq: number }, rules: readonly ResponseOverride[]): boolean {
  const rule = overriddenBy(row.url, rules);
  return rule != null && row.seq >= (since.get(rule.id) ?? 0);
}

export function saveOverride(rule: Omit<ResponseOverride, "id"> & { id?: string }): string {
  const { rules } = useResponseOverrides.getState();
  const id = rule.id ?? `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const saved = { ...rule, id, pattern: rule.pattern.trim(), status: validStatus(rule.status) };
  const before = rules.find((r) => r.id === id);
  if (saved.enabled && (!before?.enabled || before.pattern !== saved.pattern)) since.set(id, networkSerial());
  change(rules.some((r) => r.id === id) ? rules.map((r) => (r.id === id ? saved : r)) : [...rules, saved]);
  return id;
}

export function removeOverride(id: string) {
  change(useResponseOverrides.getState().rules.filter((r) => r.id !== id));
}

export function toggleOverride(id: string, on: boolean) {
  if (on && !useResponseOverrides.getState().rules.find((r) => r.id === id)?.enabled) since.set(id, networkSerial());
  change(useResponseOverrides.getState().rules.map((r) => (r.id === id ? { ...r, enabled: on } : r)));
}

/** What the debugger is given: the rules that are on and name a part of a URL. */
export function activeRules(rules: readonly ResponseOverride[]): JsResponseRule[] {
  return rules
    .filter((r) => r.enabled && r.pattern.trim())
    .map((r) => ({ urlContains: r.pattern.trim(), status: r.status, contentType: r.contentType, body: r.body }));
}

/** The rule that replaces the response of `url`, as the debugger picks it: the first that is on and matches. */
export function overriddenBy(url: string, rules: readonly ResponseOverride[]): ResponseOverride | null {
  return rules.find((r) => r.enabled && r.pattern.trim() && url.includes(r.pattern.trim())) ?? null;
}

/**
 * Gives the live page sessions (`only` those, when given) the rules. A page whose debugger
 * refuses keeps the server's responses, which is recorded for the views to say.
 */
export async function syncResponseOverrides(only?: readonly number[]): Promise<void> {
  const rules = activeRules(useResponseOverrides.getState().rules);
  const pages = Object.values(useDebug.getState().sessions).filter(
    (s) => isLive(s) && s.caps?.jsPage && (!only || only.includes(s.id)),
  );
  await Promise.all(
    pages.map((s) =>
      recordRefusal(s.id, "overrides", call(commands.debugJsResponseOverrides(s.id, rules)), () => isLiveSession(s.id)),
    ),
  );
}

/** Gives each page session the rules when it appears. Returns the unsubscribe function. */
export function watchOverrideSessions(): () => void {
  const seen = new Set<number>();
  return useDebug.subscribe((s) => {
    // Ids start over after the backend restarts: a removed session's id may come back as a new page.
    for (const id of seen) if (!s.sessions[id]) seen.delete(id);
    for (const session of Object.values(s.sessions)) {
      if (seen.has(session.id) || !session.caps?.jsPage || !isLive(session)) continue;
      seen.add(session.id);
      // A new page has none: nothing to send.
      if (activeRules(useResponseOverrides.getState().rules).length) void syncResponseOverrides([session.id]);
    }
  });
}
