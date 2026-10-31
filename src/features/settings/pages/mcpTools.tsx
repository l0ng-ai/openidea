// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.frontend/src/settings/McpToolFilterPanel.kt, McpToolFilterConfigurable.kt), Apache-2.0.
/**
 * Tools › MCP Server › Exposed Tools: the tools by toolset with tri-state
 * toolset checkboxes, each tool on / off and router-only (in router mode), a
 * search, experimental tools, the invocation mode and the advanced mask filter.
 * Edits stage `mcp.toolStates` (+ `disabledTools`), `mcp.invocationMode`,
 * `mcp.experimentalTools` and `mcp.toolsFilter` like every page.
 */
import { useEffect, useId, useMemo, useState } from "react";
import clsx from "clsx";
import { exportToolsMarkdown } from "@/features/mcp/exportTools";
import {
  FILTER_EXAMPLE,
  commonValue,
  filterAllows,
  groupTools,
  isListed,
  matchesSearch,
  toolState,
  withToolStates,
  type ToolGroup,
} from "@/features/mcp/toolStates";
import { MCP_TOOLS_PAGE } from "@/features/mcp/model";
import { tx, useTx } from "@/platform/i18n";
import { commands, isTauri, type McpToolInfo } from "@/platform/ipc";
import type { McpSettingsValid } from "@/platform/mcp";
import { Badge, Button, Checkbox, Icon, SearchField, T } from "@/ui";
import { Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import type { PageSpec } from "./spec";
import { TOOLS_GROUP } from "./tools";
import styles from "./McpTools.module.css";

function useMcpSetting<K extends keyof McpSettingsValid>(key: K) {
  return useSetting<McpSettingsValid[K]>(`mcp.${key}`, "global");
}

const KIND_LABEL: Record<McpToolInfo["kind"], () => string> = {
  read: () => tx("Read"),
  edit: () => tx("Edit"),
  execute: () => tx("Execute"),
};
const KIND_TONE = { read: "neutral", edit: "warning", execute: "danger" } as const;

function useTools(): McpToolInfo[] | null {
  const [tools, setTools] = useState<McpToolInfo[] | null>(isTauri() ? null : []);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const show = (list: McpToolInfo[]) => {
      if (live) setTools(list);
    };
    void commands.mcpTools().then(show, () => show([]));
    return () => {
      live = false;
    };
  }, []);
  return tools;
}

function RouterOptions() {
  const [mode, setMode] = useMcpSetting("invocationMode");
  const [experimental, setExperimental] = useMcpSetting("experimentalTools");
  return (
    <div className={styles.block}>
      <Toggle
        label="Enable router-only mode"
        checked={mode === "viaRouter"}
        onChange={(on) => setMode(on ? "viaRouter" : "direct")}
        hint="Router-only mode helps save context by keeping unnecessary tool descriptions out of the MCP tool list. When enabled, tools marked as Router-only are hidden from direct access via MCP and remain available only through the dedicated tool. Describe router-only tools in Skills or other agent docs so agents know when to use them."
      />
      <Toggle
        label="Offer experimental tools"
        checked={experimental}
        onChange={setExperimental}
        hint="Experimental tools are listed here and offered to clients only while this is on, unless switched on one by one."
      />
    </div>
  );
}

function ExposedTools() {
  const t = useTx();
  const tools = useTools();
  const [toolStates, setToolStates] = useMcpSetting("toolStates");
  const [disabledTools, setDisabledTools] = useMcpSetting("disabledTools");
  const [mode] = useMcpSetting("invocationMode");
  const [experimental] = useMcpSetting("experimentalTools");
  const [filter] = useMcpSetting("toolsFilter");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const settings = useMemo(() => ({ toolStates, disabledTools }), [toolStates, disabledTools]);
  const router = mode === "viaRouter";

  const groups = useMemo(() => {
    const listed = (tools ?? []).filter((tool) => isListed(tool, settings, experimental));
    return groupTools(listed)
      .map((g) => ({ ...g, tools: g.tools.filter((tool) => matchesSearch(tool, query)) }))
      .filter((g) => g.tools.length);
  }, [tools, settings, experimental, query]);

  if (!tools) return <div className={styles.note}>{t("Loading tools…")}</div>;

  const update = (list: readonly McpToolInfo[], change: (s: { enabled: boolean; routerOnly: boolean }) => object) => {
    const next = withToolStates(settings, list, (s) => ({ ...s, ...change(s) }));
    setToolStates(next.toolStates);
    setDisabledTools(next.disabledTools);
  };
  const visible = groups.flatMap((g) => g.tools);
  const enabledCount = visible.filter((tool) => toolState(tool, settings).enabled).length;
  const routerOnlyCount = visible.filter((tool) => {
    const s = toolState(tool, settings);
    return s.enabled && s.routerOnly;
  }).length;
  const searching = !!query.trim();

  return (
    <div className={styles.block}>
      <div className={styles.toolbar}>
        <SearchField
          className={styles.search}
          value={query}
          onChange={setQuery}
          placeholder={t("Search tools")}
          aria-label={t("Search tools")}
          clearable
        />
        <span className={styles.counts}>{t`${enabledCount} enabled, ${routerOnlyCount} router-only`}</span>
      </div>
      {!groups.length && <div className={styles.note}>{t("No tools match the current search")}</div>}
      <div className={styles.groups} aria-label={t("MCP tools")} role="list">
        {groups.map((g) => (
          <Group
            key={g.group}
            group={g}
            expanded={searching || !collapsed.has(g.group)}
            onToggle={() =>
              setCollapsed((c) => {
                const n = new Set(c);
                if (n.has(g.group)) n.delete(g.group);
                else n.add(g.group);
                return n;
              })
            }
            settings={settings}
            router={router}
            filter={filter}
            update={update}
          />
        ))}
      </div>
    </div>
  );
}

interface GroupProps {
  group: ToolGroup;
  expanded: boolean;
  onToggle: () => void;
  settings: Parameters<typeof toolState>[1];
  router: boolean;
  filter: string;
  update: (list: readonly McpToolInfo[], change: (s: { enabled: boolean; routerOnly: boolean }) => object) => void;
}

function Group({ group, expanded, onToggle, settings, router, filter, update }: GroupProps) {
  const t = useTx();
  const name = group.name;
  const enabled = commonValue(group.tools, (tool) => toolState(tool, settings).enabled);
  const on = group.tools.filter((tool) => toolState(tool, settings).enabled);
  const routerOnly = on.length ? commonValue(on, (tool) => toolState(tool, settings).routerOnly) : false;
  return (
    <div className={styles.group} role="listitem" aria-label={name}>
      <div className={styles.groupHead}>
        <button type="button" className={styles.groupTitle} aria-expanded={expanded} onClick={onToggle}>
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
          {name}
        </button>
        <span className={styles.rule} />
        <Checkbox
          aria-label={t`${name}: Enabled`}
          label={t("Enabled")}
          checked={enabled === true}
          indeterminate={enabled === null}
          onChange={() => update(group.tools, () => ({ enabled: enabled !== true }))}
        />
        {router && (
          <Checkbox
            aria-label={t`${name}: Router-only`}
            label={t("Router-only")}
            checked={routerOnly === true}
            indeterminate={routerOnly === null}
            disabled={!on.length}
            onChange={() => update(on, () => ({ routerOnly: routerOnly !== true }))}
          />
        )}
      </div>
      {expanded && (
        <ul className={styles.tools}>
          {group.tools.map((tool) => {
            const state = toolState(tool, settings);
            const name = tool.name;
            return (
              <li key={tool.fullyQualifiedName} className={styles.tool}>
                <div className={styles.toolHead}>
                  <span className={styles.toolName}>{tool.name}</span>
                  <Badge tone={KIND_TONE[tool.kind]}>{KIND_LABEL[tool.kind]()}</Badge>
                  {tool.experimental && <Badge tone="accent">{t("Experimental")}</Badge>}
                  {filter.trim() && !filterAllows(filter, tool) && (
                    <Badge tone="warning">{t("Hidden by the advanced filter")}</Badge>
                  )}
                  <span className={styles.spacer} />
                  <Checkbox
                    aria-label={tool.name}
                    label={t("Enabled")}
                    checked={state.enabled}
                    onChange={(v) => update([tool], () => ({ enabled: v }))}
                  />
                  {router && (
                    <Checkbox
                      aria-label={t`${name}: Router-only`}
                      label={t("Router-only")}
                      checked={state.routerOnly}
                      disabled={!state.enabled}
                      onChange={(v) => update([tool], () => ({ routerOnly: v }))}
                    />
                  )}
                </div>
                <div className={clsx(styles.description)} data-tooltip={tool.description}>
                  {tool.description}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AdvancedFilter() {
  const [filter, setFilter] = useMcpSetting("toolsFilter");
  const [shown, setShown] = useState(() => !!filter.trim());
  const id = useId();
  const example = FILTER_EXAMPLE;
  return (
    <div className={styles.block}>
      <div className={styles.toolbar}>
        <button type="button" className={styles.link} aria-expanded={shown} onClick={() => setShown((v) => !v)}>
          <T>Advanced filter</T>
        </button>
        <span className={styles.spacer} />
        <Button size="small" icon="export" onClick={() => void exportToolsMarkdown()}>
          Export to Markdown
        </Button>
      </div>
      {shown && (
        <>
          <label htmlFor={id} className={styles.note}>
            <T>Advanced filter:</T>
          </label>
          <textarea
            id={id}
            className={styles.filter}
            rows={2}
            spellCheck={false}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className={styles.note}>{tx`Example: ${example}`}</div>
        </>
      )}
    </div>
  );
}

export const MCP_TOOLS_PAGES: PageSpec[] = [
  {
    id: MCP_TOOLS_PAGE,
    title: "Exposed Tools",
    group: TOOLS_GROUP,
    order: 605,
    keywords: ["mcp", "tools", "router", "execute_tool", "filter", "experimental", "toolset"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Enable router-only mode",
            keywords: ["Offer experimental tools"],
            component: RouterOptions,
          },
        ],
      },
      {
        options: [
          {
            kind: "custom",
            label: "Advanced filter",
            keywords: ["Export to Markdown"],
            component: AdvancedFilter,
          },
        ],
      },
      {
        title: "Tools",
        options: [{ kind: "custom", label: "MCP tools", keywords: ["Router-only"], component: ExposedTools }],
      },
    ],
  },
];
