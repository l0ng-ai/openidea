import type { RunConfig } from "@/bindings";
import { validateLanguages } from "./languageSettings";
import { useProject } from "./project";
import { workflowSettings } from "./workflowSettings";

/** Mirrors ide-sdk's interpreter target selection for guards before IPC launch. */
export function withRunTarget(config: RunConfig): RunConfig {
  if (config.target !== undefined && config.target !== null) return config;
  const languages = validateLanguages(useProject.getState().settings?.languages);
  const name = config.command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd|bat)$/i, "");
  const selected =
    ["php", "composer", "phpunit", "pest"].includes(name ?? "") || ["php", "composer", "phpunit"].includes(config.kind)
      ? languages.php.runTarget
      : ["node", "npm", "npx", "pnpm", "yarn", "bun"].includes(name ?? "") ||
          ["node", "npm", "vitest", "jest", "mocha"].includes(config.kind)
        ? languages.node.runTarget
        : "";
  if (selected === "local") return { ...config, target: "" };
  const target = selected || workflowSettings().run.defaultTarget;
  return target ? { ...config, target } : config;
}
