/**
 * Watches of a program that is running: a debugger that evaluates without suspending
 * (js-debug, `liveEvaluate`) is asked for them again and again, like a browser's live
 * expressions. Elsewhere a watch has a value only while suspended.
 */
import { useEffect, useState } from "react";
import { call, commands, type Variable } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import type { DebugSession } from "../state";

/** How often the watches of a running program are evaluated again. */
export const LIVE_WATCH_INTERVAL_MS = 1000;

export interface LiveWatch {
  expression: string;
  result: Variable | null;
  error: string | null;
}

const NONE: LiveWatch[] = [];

/** Sessions whose watches are being evaluated right now. */
const evaluating = new Set<number>();

/** Whether the watches of `session` are evaluated while it runs. */
export function liveWatchesApply(session: DebugSession | undefined): boolean {
  return (
    !!session && session.status === "running" && !!session.caps?.liveEvaluate && workflowSettings().debugger.liveWatches
  );
}

/**
 * The current values of `watches` in the running `session`, refreshed every
 * `LIVE_WATCH_INTERVAL_MS` while `visible`; empty when they don't apply. A watch with a side
 * effect has it again on each refresh.
 */
export function useLiveWatches(
  session: DebugSession | undefined,
  watches: readonly string[],
  visible: boolean,
): LiveWatch[] {
  const [data, setData] = useState<{ session: number; rows: LiveWatch[] }>({ session: -1, rows: NONE });
  const apply = visible && watches.length > 0 && liveWatchesApply(session);
  const id = session?.id ?? -1;
  // A stable dependency for the list; a watch may span several lines.
  const expressions = JSON.stringify(watches);
  useEffect(() => {
    if (!apply) return;
    let current = true;
    const refresh = async () => {
      // A slow evaluation isn't joined by a second one, whichever watch list asked for it.
      if (evaluating.has(id)) return;
      evaluating.add(id);
      const rows = await Promise.all(
        (JSON.parse(expressions) as string[]).map(async (expression): Promise<LiveWatch> => {
          try {
            return {
              expression,
              result: await call(commands.debugEvaluateIn(id, null, expression, "watch")),
              error: null,
            };
          } catch (e) {
            return { expression, result: null, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      evaluating.delete(id);
      if (current) setData({ session: id, rows });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), LIVE_WATCH_INTERVAL_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [apply, id, expressions]);
  return apply && data.session === id ? data.rows : NONE;
}
