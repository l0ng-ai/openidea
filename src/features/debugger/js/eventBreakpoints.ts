/**
 * Breakpoints of a debugged page that aren't on a line: on a DOM event or timer firing, and on
 * a fetch / XHR whose URL contains some text (js-debug's custom breakpoints). They are kept
 * per project and sent to every page session, like exception breakpoints.
 */
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { isLive, isLiveSession, useDebug, type DebugSession } from "../state";
import { forgetRefusals, recordRefusal, useJsRefusals } from "./refusals";

/**
 * Why a session is suspended when no line says it: the adapter's words for the event
 * (`button.click`) or request breakpoint it stopped at.
 */
export function stopNote(s: Pick<DebugSession, "status" | "stopReason" | "stopDescription">): string | null {
  if (s.status !== "paused" || !s.stopDescription) return null;
  return s.stopReason === "function breakpoint" || s.stopReason === "data breakpoint" ? s.stopDescription : null;
}

export interface JsBreakpoints {
  /** Breakpoint id (`listener:click`) → enabled. */
  events: Record<string, boolean>;
  requests: Array<{ pattern: string; enabled: boolean }>;
}

/**
 * The events offered. js-debug accepts any id without checking it, so a free-form name
 * would fail silently; these are ones it knows.
 */
export const EVENT_GROUPS: ReadonlyArray<{ title: string; ids: readonly string[] }> = [
  {
    title: "Mouse",
    ids: ["listener:click", "listener:dblclick", "listener:mousedown", "listener:mouseup", "listener:contextmenu"],
  },
  { title: "Keyboard", ids: ["listener:keydown", "listener:keyup", "listener:input"] },
  { title: "Form", ids: ["listener:submit", "listener:change", "listener:focus", "listener:blur"] },
  { title: "Page", ids: ["listener:load", "listener:DOMContentLoaded", "listener:scroll", "listener:resize"] },
  {
    title: "Timers",
    ids: ["instrumentation:setTimeout", "instrumentation:setInterval", "instrumentation:requestAnimationFrame"],
  },
];

const KNOWN_EVENTS = EVENT_GROUPS.flatMap((g) => g.ids);

/** `listener:click` → `click`. */
export const eventName = (id: string) => id.slice(id.indexOf(":") + 1);

const PREFIX = "openidea.debugger.jsBreakpoints:";

interface State extends JsBreakpoints {
  root: string | null;
}

export const useJsBreakpoints = create<State>(() => ({ root: null, events: {}, requests: [] }));

function stored(root: string): JsBreakpoints {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + root) ?? "null") as Partial<JsBreakpoints> | null;
    const events: Record<string, boolean> = {};
    for (const id of KNOWN_EVENTS) if (raw?.events?.[id] === true) events[id] = true;
    const requests = (Array.isArray(raw?.requests) ? raw.requests : [])
      .filter((r) => typeof r?.pattern === "string" && r.pattern.trim())
      .map((r) => ({ pattern: r.pattern.trim(), enabled: r.enabled !== false }));
    return { events, requests };
  } catch {
    return { events: {}, requests: [] };
  }
}

export function loadJsBreakpoints(root: string | null) {
  useJsBreakpoints.setState({ root, ...(root ? stored(root) : { events: {}, requests: [] }) });
  void syncJsBreakpoints();
}

function change(next: Partial<JsBreakpoints>) {
  useJsBreakpoints.setState(next);
  const { root, events, requests } = useJsBreakpoints.getState();
  if (root) {
    try {
      localStorage.setItem(PREFIX + root, JSON.stringify({ events, requests }));
    } catch {
      // Storage unavailable: they last for this session only.
    }
  }
  void syncJsBreakpoints();
}

/** What js-debug's `setCustomBreakpoints` takes: the enabled events it knows and URL parts. */
export function customBreakpointArgs(b: JsBreakpoints): { ids: string[]; xhr: string[] } {
  return {
    ids: KNOWN_EVENTS.filter((id) => b.events[id]),
    xhr: b.requests.filter((r) => r.enabled).map((r) => r.pattern),
  };
}

export function setEventBreakpoint(id: string, on: boolean) {
  change({ events: { ...useJsBreakpoints.getState().events, [id]: on } });
}

export function addRequestBreakpoint(pattern: string) {
  const p = pattern.trim();
  const { requests } = useJsBreakpoints.getState();
  if (!p || requests.some((r) => r.pattern === p)) return;
  change({ requests: [...requests, { pattern: p, enabled: true }] });
}

export function removeRequestBreakpoint(pattern: string) {
  change({ requests: useJsBreakpoints.getState().requests.filter((r) => r.pattern !== pattern) });
}

export function toggleRequestBreakpoint(pattern: string, on: boolean) {
  const { requests } = useJsBreakpoints.getState();
  change({ requests: requests.map((r) => (r.pattern === pattern ? { ...r, enabled: on } : r)) });
}

/**
 * Sends the breakpoints to the live page sessions (to `only` those, when given). A page whose
 * debugger refuses has no such breakpoints, which is recorded for the dialog to say.
 */
export async function syncJsBreakpoints(only?: readonly number[]): Promise<void> {
  const { ids, xhr } = customBreakpointArgs(useJsBreakpoints.getState());
  const pages = Object.values(useDebug.getState().sessions).filter(
    (s) => isLive(s) && s.caps?.jsPage && (!only || only.includes(s.id)),
  );
  await Promise.all(
    pages.map((s) =>
      recordRefusal(s.id, "eventBreakpoints", call(commands.debugJsCustomBreakpoints(s.id, ids, xhr)), () =>
        isLiveSession(s.id),
      ),
    ),
  );
}

/**
 * Gives each page session the breakpoints when it appears, and forgets what a session's
 * debugger refused when the session is removed. Returns the unsubscribe function.
 */
export function watchPageSessions(): () => void {
  const seen = new Set<number>();
  return useDebug.subscribe((s) => {
    for (const id of Object.keys(useJsRefusals.getState().refused)) if (!s.sessions[+id]) forgetRefusals(+id);
    for (const session of Object.values(s.sessions)) {
      if (seen.has(session.id) || !session.caps?.jsPage || !isLive(session)) continue;
      seen.add(session.id);
      const { ids, xhr } = customBreakpointArgs(useJsBreakpoints.getState());
      // A new page has none: nothing to send.
      if (ids.length || xhr.length) void syncJsBreakpoints([session.id]);
    }
  });
}
