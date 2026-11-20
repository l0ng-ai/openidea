import { lazyComponent } from "@/ui";
import { registerSettingsPages } from "@/workbench/contributions";
import { AGENTS_GROUP, MCP_PAGE, POLICY_PAGE, REGISTRY_PAGE } from "./model";

/** Settings › Agents › Coding Agents and Settings › Agents › External MCP Servers (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPages([
    {
      id: REGISTRY_PAGE,
      title: "Coding Agents",
      group: AGENTS_GROUP,
      // First in Agents, which sits after Languages & Frameworks and before Tools.
      order: 450,
      keywords: ["agent", "acp", "registry", "install", "update", "coding agent"],
      component: lazyComponent(() => import("./AgentRegistryPage").then((m) => m.AgentRegistryPage)),
    },
    {
      id: MCP_PAGE,
      title: "External MCP Servers",
      group: AGENTS_GROUP,
      order: 475,
      keywords: ["mcp", "model context protocol", "servers", "tools", "agent"],
      component: lazyComponent(() => import("./McpServersPage").then((m) => m.McpServersPage)),
    },
    {
      id: POLICY_PAGE,
      title: "Command Permissions",
      group: AGENTS_GROUP,
      order: 490,
      keywords: ["agent", "policy", "security", "whitelist", "blacklist", "permission", "command", "exec"],
      component: lazyComponent(() => import("./AgentPolicyPage").then((m) => m.AgentPolicyPage)),
    },
  ]);
}
