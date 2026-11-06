/**
 * Tells the backend what the Problems view lists, for plugins
 * (`diagnostics.problems`, which AI agents reach through MCP tools): the files
 * whose problems changed, once diagnostics settle. Remote windows' plugins run
 * on their server, which doesn't read these.
 */
import { commands, type FileProblems } from "@/bindings";
import { isRemoteWindow } from "@/platform/remote";
import { useProblems, type ProblemsMap } from "./problemsStore";

const REPORT_MS = 1000;

export function reportProblems(): () => void {
  let reported: ProblemsMap = new Map();
  let reset = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (isRemoteWindow()) return;
    const map = useProblems.getState().map;
    const files: FileProblems[] = [];
    for (const [path, sources] of map)
      if (reset || reported.get(path) !== sources) files.push({ path, items: [...sources.values()].flat() });
    if (!reset) for (const path of reported.keys()) if (!map.has(path)) files.push({ path, items: [] });
    if (!files.length && !reset) return;
    const wasReset = reset;
    reported = map;
    reset = false;
    commands.pluginReportProblems(wasReset, files).catch(() => (reset = true));
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, REPORT_MS);
  };
  schedule();
  const off = useProblems.subscribe((s, prev) => {
    if (s.map !== prev.map) schedule();
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}
