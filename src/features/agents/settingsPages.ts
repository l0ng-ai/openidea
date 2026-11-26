import { lazyComponent } from "@/ui";
import { registerSettingsPages } from "@/workbench/contributions";
import { AGENTS_GROUP, MCP_PAGE, POLICY_PAGE, REGISTRY_PAGE, SKILLS_PAGE } from "./model";

export function activateSettingsPages(): () => void {
  return registerSettingsPages([
    {
      id: REGISTRY_PAGE,
      title: "Agent Setup",
      group: AGENTS_GROUP,
      // First in Agents, which sits after Languages & Frameworks and before Tools.
      order: 450,
      keywords: ["agent", "acp", "registry", "install", "update", "Coding Agents"],
      component: lazyComponent(() => import("./AgentRegistryPage").then((m) => m.AgentRegistryPage)),
    },
    {
      id: MCP_PAGE,
      title: "MCP Connections",
      group: AGENTS_GROUP,
      order: 475,
      keywords: ["mcp", "model context protocol", "servers", "tools", "agent", "External MCP Servers"],
      component: lazyComponent(() => import("./McpServersPage").then((m) => m.McpServersPage)),
    },
    {
      id: SKILLS_PAGE,
      title: "Skills",
      group: AGENTS_GROUP,
      order: 480,
      keywords: ["skills", "skill", "skill.md", "agents", "slash commands", "auto", "slash only"],
      component: lazyComponent(() => import("./SkillsPage").then((m) => m.SkillsPage)),
    },
    {
      id: POLICY_PAGE,
      title: "Command Rules",
      group: AGENTS_GROUP,
      order: 490,
      keywords: ["agent", "policy", "security", "whitelist", "blacklist", "Command Permissions", "exec"],
      component: lazyComponent(() => import("./AgentPolicyPage").then((m) => m.AgentPolicyPage)),
    },
  ]);
}
