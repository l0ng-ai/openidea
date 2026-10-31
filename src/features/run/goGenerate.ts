import type { RunConfig } from "@/platform/ipc";
import type { MenuGroupContext } from "@/workbench/contributions";

export function goGenerateConfig(path: string, scope: "file" | "package", directive?: string): RunConfig | null {
  if (!path.endsWith(".go") || path.includes("\0")) return null;
  const slash = path.lastIndexOf("/");
  const file = path.slice(slash + 1);
  const pattern = directive ? `^${directive.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : null;
  const target = scope === "package" ? "." : file.startsWith("-") ? `./${file}` : file;
  return {
    id: `go:generate:${scope}:${path}:${pattern ?? ""}`,
    name: `go generate ${target}`,
    kind: "go",
    command: "go",
    args: ["generate", ...(pattern ? ["-run", pattern] : []), target],
    cwd: slash < 0 ? null : path.slice(0, slash) || "/",
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
    params: { useTags: "true" },
  };
}

export function goGenerateMenu(ctx: MenuGroupContext) {
  const path = ctx.paths.length === 1 ? ctx.paths[0]! : "";
  if (!path.endsWith(".go") || ctx.dirs?.[0]) return [];
  return [
    { kind: "action" as const, action: "go.generate.file", arg: { path } },
    { kind: "action" as const, action: "go.generate.package", arg: { path } },
  ];
}
