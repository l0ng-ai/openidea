// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.frontend/src/settings/McpToolFilterPanel.kt, McpToolFilterConfigurable.kt; src/com/intellij/mcpserver/MaskList.kt), Apache-2.0.
/**
 * Settings › Tools › MCP Server › Exposed Tools as a model: the tools grouped by
 * toolset, each tool's state under the staged settings (`toolStates`, with the
 * older `disabledTools` as a fallback, like `ide-mcp::filter`), and the settings
 * an edit writes.
 */
import type { McpToolInfo } from "@/platform/ipc";
import { DEFAULT_MCP_TOOL_STATE, type McpSettingsValid, type McpToolStateValid } from "@/platform/mcp";

/** `ide-mcp::filter::ROUTER_TOOL_NAME`: listed by the invocation mode, not by a state of its own. */
export const ROUTER_TOOL = "execute_tool";

/** What JetBrains' advanced filter field shows as its example. */
export const FILTER_EXAMPLE = "-*,+com.intellij.mcpserver.toolsets.general.*,-*.read_file";

/** `ide-mcp::filter::JETBRAINS_PACKAGE`: masks match our names and the JetBrains ones. */
const JETBRAINS_PACKAGE = "com.intellij.mcpserver.toolsets.";

export type ToolSettings = Pick<McpSettingsValid, "toolStates" | "disabledTools">;

export interface ToolGroup {
  group: string;
  name: string;
  tools: McpToolInfo[];
}

/**
 * The toolsets by display name, their tools by name (`buildCategoryGroups`);
 * the router is not a row of its own (the invocation mode lists it).
 */
export function groupTools(tools: readonly McpToolInfo[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const tool of tools) {
    if (tool.name === ROUTER_TOOL) continue;
    let g = groups.get(tool.group);
    if (!g) groups.set(tool.group, (g = { group: tool.group, name: tool.groupName, tools: [] }));
    g.tools.push(tool);
  }
  const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
  return [...groups.values()]
    .map((g) => ({ ...g, tools: [...g.tools].sort((a, b) => byName(a.name, b.name)) }))
    .sort((a, b) => byName(a.name, b.name));
}

/** The state stored for `tool`: by qualified name, then plain name, then `disabledTools`. */
export function storedState(tool: McpToolInfo, s: ToolSettings): McpToolStateValid | undefined {
  return (
    s.toolStates[tool.fullyQualifiedName] ??
    s.toolStates[tool.name] ??
    (s.disabledTools.includes(tool.name) ? { enabled: false, routerOnly: true } : undefined)
  );
}

export function toolState(tool: McpToolInfo, s: ToolSettings): McpToolStateValid {
  return storedState(tool, s) ?? DEFAULT_MCP_TOOL_STATE;
}

const sameState = (a: McpToolStateValid, b: McpToolStateValid) =>
  a.enabled === b.enabled && a.routerOnly === b.routerOnly;

/**
 * The settings after `update` changed the state of `tools`. States are stored by
 * qualified name, and only when they differ from the default (`statesToPersist`);
 * a plain-name entry of the same tool goes. `disabledTools` keeps naming the
 * disabled tools, for what still reads only it (the skills' availability).
 */
export function withToolStates(
  s: ToolSettings,
  tools: readonly McpToolInfo[],
  update: (state: McpToolStateValid) => McpToolStateValid,
): ToolSettings {
  const toolStates = { ...s.toolStates };
  const disabled = new Set(s.disabledTools);
  for (const tool of tools) {
    const next = update(toolState(tool, s));
    delete toolStates[tool.name];
    if (sameState(next, DEFAULT_MCP_TOOL_STATE)) delete toolStates[tool.fullyQualifiedName];
    else toolStates[tool.fullyQualifiedName] = next;
    if (next.enabled) disabled.delete(tool.name);
    else disabled.add(tool.name);
  }
  return { toolStates, disabledTools: [...disabled].sort() };
}

/** One value for every tool, or `null` when they differ (a tri-state checkbox). */
export function commonValue(tools: readonly McpToolInfo[], value: (t: McpToolInfo) => boolean): boolean | null {
  if (!tools.length) return null;
  const first = value(tools[0]!);
  return tools.every((t) => value(t) === first) ? first : null;
}

/** The search box: name, toolset and description, ignoring case. */
export function matchesSearch(tool: McpToolInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [tool.name, tool.groupName, tool.group, tool.description].some((t) => t.toLowerCase().includes(q));
}

/** Experimental tools are listed with experimental tools on, or when switched on explicitly. */
export function isListed(tool: McpToolInfo, s: ToolSettings, experimentalTools: boolean): boolean {
  return !tool.experimental || experimentalTools || storedState(tool, s)?.enabled === true;
}

// --- the advanced filter (`MaskList`) --------------------------------------------

function wildcard(mask: string, text: string): boolean {
  let mi = 0;
  let ti = 0;
  let star: [number, number] | null = null;
  while (ti < text.length) {
    if (mi < mask.length && (mask[mi] === "?" || mask[mi] === text[ti])) {
      mi++;
      ti++;
    } else if (mi < mask.length && mask[mi] === "*") {
      star = [mi, ti];
      mi++;
    } else if (star) {
      mi = star[0] + 1;
      ti = ++star[1];
    } else return false;
  }
  while (mask[mi] === "*") mi++;
  return mi === mask.length;
}

/** Whether the mask list `filter` lets `tool` through (the last matching mask wins; blank: no filter). */
export function filterAllows(filter: string, tool: McpToolInfo): boolean {
  const names = [tool.fullyQualifiedName, JETBRAINS_PACKAGE + tool.fullyQualifiedName];
  let allowed = true;
  for (const raw of filter.split(",")) {
    const m = raw.trim();
    if (!m) continue;
    const allow = m[0] !== "-";
    const mask = m[0] === "-" || m[0] === "+" ? m.slice(1) : m;
    if (names.some((n) => wildcard(mask, n))) allowed = allow;
  }
  return allowed;
}
