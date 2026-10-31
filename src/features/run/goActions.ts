import { executeAction, getAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import type { RunConfig } from "@/platform/ipc";
import { registerMenuGroup, maybeEditorService, type MenuGroupContext } from "@/workbench/contributions";
import { promptInput } from "@/workbench/inputDialogs";
import { goGenerateConfig, goGenerateMenu } from "./goGenerate";
import { invalidateGoModules } from "./goModules";
import { loadConfigs, startRun } from "./store";

export type GoModuleOperation = "tidy" | "download" | "sync" | "use";
const ACTIONS = {
  tidy: { id: "go.mod.tidy", title: "Go Mod Tidy" },
  download: { id: "go.mod.download", title: "Download Go Modules" },
  sync: { id: "go.work.sync", title: "Sync Go Workspace" },
  use: { id: "go.work.use", title: "Add Directory to Go Workspace…" },
} as const;

export function goModuleCommand(operation: GoModuleOperation, path: string, directory?: string): RunConfig | null {
  const module = operation === "tidy" || operation === "download";
  if (!path.endsWith(module ? "/go.mod" : "/go.work") || path.includes("\0")) return null;
  if (operation === "use" && (!directory?.trim() || directory.includes("\0"))) return null;
  const args = [module ? "mod" : "work", operation, ...(operation === "use" ? ["--", directory!] : [])];
  return {
    id: `go:${operation}:${path}`,
    name: `go ${args.slice(0, 2).join(" ")}`,
    kind: "go",
    command: "go",
    args,
    cwd: path.slice(0, path.lastIndexOf("/")),
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
  };
}

export function goModuleMenu(ctx: MenuGroupContext) {
  const path = ctx.paths.length === 1 ? ctx.paths[0]! : "";
  const operations: GoModuleOperation[] = path.endsWith("/go.mod")
    ? ["tidy", "download"]
    : path.endsWith("/go.work")
      ? ["sync", "use"]
      : [];
  return operations.map((op) => ({ kind: "action" as const, action: ACTIONS[op].id, arg: { path } }));
}

export function registerGoActions(): () => void {
  const actions = registerActions([
    ...Object.entries(ACTIONS).map(([operation, spec]) => ({
      ...spec,
      category: "Go",
      when: "projectOpen",
      run: async ({ arg }: { arg?: unknown }) => {
        const params = arg && typeof arg === "object" ? (arg as { path?: string; directory?: string }) : {};
        const path =
          typeof arg === "string"
            ? arg
            : typeof params.path === "string"
              ? params.path
              : (maybeEditorService()?.activePath() ?? "");
        let directory = typeof params.directory === "string" ? params.directory : undefined;
        if (operation === "use" && !directory) {
          directory =
            (await promptInput({
              title: "Add Directory to Go Workspace",
              label: "Module directory",
              initial: "./",
              hint: "Path relative to go.work, or an absolute directory containing go.mod",
            })) ?? undefined;
          if (!directory) return;
        }
        const config = goModuleCommand(operation as GoModuleOperation, path, directory);
        if (!config) return;
        const root = useProject.getState().project?.root;
        await startRun(config, undefined, undefined, {
          onExit: () => {
            if (useProject.getState().project?.root !== root) return;
            invalidateGoModules();
            void loadConfigs();
            if (getAction("libraries.reload")) void executeAction("libraries.reload");
          },
        });
      },
    })),
    ...(["file", "package"] as const).map((scope) => ({
      id: `go.generate.${scope}`,
      title: scope === "file" ? "Go Generate File" : "Go Generate Package",
      category: "Go",
      when: "projectOpen",
      run: async ({ arg }: { arg?: unknown }) => {
        const path =
          typeof arg === "string"
            ? arg
            : arg && typeof arg === "object" && "path" in arg && typeof arg.path === "string"
              ? arg.path
              : (maybeEditorService()?.activePath() ?? "");
        const config = goGenerateConfig(path, scope);
        if (config) await startRun(config);
      },
    })),
  ]);
  const menu = registerMenuGroup({
    id: "go.modules",
    menus: ["projectView", "editorTab", "editor"],
    items: (_menu, ctx) => [...goModuleMenu(ctx), ...goGenerateMenu(ctx)],
  });
  return () => {
    menu();
    actions();
  };
}
