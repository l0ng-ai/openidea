/**
 * What the debugger of a page turned down. The page tools use requests of js-debug's own,
 * which differ between its versions: a tool it refuses says so instead of looking idle.
 */
import { create } from "zustand";

export type JsTool = "eventBreakpoints";

/** Per session, the reason each refused tool was refused for. */
export const useJsRefusals = create<{ refused: Record<number, Partial<Record<JsTool, string>>> }>(() => ({
  refused: {},
}));

/** Records that `tool` was refused in `session` (`why`), or that it works (null). */
export function setRefused(session: number, tool: JsTool, why: string | null) {
  const { refused } = useJsRefusals.getState();
  if ((refused[session]?.[tool] ?? null) === why) return;
  const tools = { ...refused[session] };
  if (why == null) delete tools[tool];
  else tools[tool] = why;
  useJsRefusals.setState({ refused: { ...refused, [session]: tools } });
}

/**
 * Records how a tool's `request` to the debugger of `session` ended. `live` tells whether the
 * session still runs afterwards: one that ended meanwhile refused nothing.
 */
export async function recordRefusal(
  session: number,
  tool: JsTool,
  request: Promise<unknown>,
  live: () => boolean,
): Promise<void> {
  try {
    await request;
    setRefused(session, tool, null);
  } catch (e) {
    if (live()) setRefused(session, tool, e instanceof Error ? e.message : String(e));
  }
}

export const refusedIn = (session: number, tool: JsTool) => useJsRefusals.getState().refused[session]?.[tool];

export function forgetRefusals(session: number) {
  const { refused } = useJsRefusals.getState();
  if (!(session in refused)) return;
  const kept = { ...refused };
  delete kept[session];
  useJsRefusals.setState({ refused: kept });
}
