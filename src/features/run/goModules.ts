/**
 * Go module paths (`module example.com/app` in `go.mod`) of the project's Go
 * configurations, for GoLand's configuration names (`go test example.com/app/calc`,
 * `TestAdd in example.com/app/calc`). Read once per module directory.
 */
import { call, commands, isTauri, type RunConfig } from "@/platform/ipc";
import { goModuleDir } from "./producers";

const known = new Map<string, string | null>();

export function parseGoModule(gomod: string): string | null {
  const m = /^\s*module\s+("?)([^\s"]+)\1/m.exec(gomod);
  return m?.[2] ?? null;
}

/** The module path of `dir` when already read: `null` without a readable `go.mod`. */
export function goModulePath(dir: string): string | null | undefined {
  return known.get(dir);
}

/** Reads the `go.mod` of every Go configuration's module not read yet. */
export async function loadGoModules(root: string | null, configs: readonly RunConfig[]): Promise<void> {
  if (!root || !isTauri()) return;
  const dirs = new Set(configs.filter((c) => c.kind === "go").map((c) => goModuleDir(root, c.cwd)));
  await Promise.all(
    [...dirs]
      .filter((d) => !known.has(d))
      .map(async (d) => {
        try {
          known.set(d, parseGoModule(await call(commands.fsReadText(`${d}/go.mod`))));
        } catch {
          known.set(d, null);
        }
      }),
  );
}
