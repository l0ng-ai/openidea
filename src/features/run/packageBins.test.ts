import { beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "@/platform/actions";
import { commands, type FileEntry, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import {
  declaredBins,
  execConfig,
  execItems,
  loadPackages,
  packageBinsRunAnything,
  parseExecLine,
} from "./packageBins";
import { useRun } from "./store";

// A pnpm-less hoisted workspace: the root and `packages/web`.
const FILES: Record<string, unknown> = {
  "/p/package.json": { name: "mono", devDependencies: { eslint: "9" } },
  "/p/node_modules/eslint/package.json": { bin: { eslint: "bin/eslint.js" } },
  "/p/node_modules/@prisma/cli/package.json": { bin: "build/index.js" },
  "/p/packages/web/package.json": { name: "web", dependencies: { "@prisma/cli": "5", "left-pad": "1" } },
};
const BIN_DIRS: Record<string, string[]> = {
  "/p/node_modules/.bin": ["eslint", "eslint.cmd", "eslint.ps1", "tsc", "cli"],
  "/p/packages/web/node_modules/.bin": ["vite"],
};
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const missing = { status: "error" as const, error: { kind: "notFound", message: "missing" } as never };
const entry = (name: string) => ({ name, kind: "file" }) as FileEntry;
const webConfig = { id: "npm:web:dev", kind: "npm", detected: true, cwd: "packages/web" } as RunConfig;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(commands, "fsReadText").mockImplementation(async (path) =>
    path in FILES ? ok(JSON.stringify(FILES[path])) : missing,
  );
  vi.spyOn(commands, "fsReadDir").mockImplementation(async (path) =>
    path in BIN_DIRS ? ok(BIN_DIRS[path]!.map(entry)) : missing,
  );
});

describe("package executables", () => {
  it("parses the runners' command lines", () => {
    expect(parseExecLine("npx")).toMatchObject({ runner: { command: "npx" }, name: "", rest: "" });
    expect(parseExecLine("pnpm  exec vi --open")).toMatchObject({
      runner: { prefix: "pnpm exec", args: ["exec"] },
      name: "vi",
      rest: "--open",
    });
    expect(parseExecLine("bunx tsc")?.runner.command).toBe("bunx");
    expect(parseExecLine("yarn eslint .")).toMatchObject({ name: "eslint", rest: "." });
    expect(parseExecLine("npm run dev")).toBeNull();
    expect(parseExecLine("pnpm install")).toBeNull();
    expect(parseExecLine("npxfoo")).toBeNull();
  });

  it("names a string `bin` after the package without its scope", () => {
    expect(declaredBins("@prisma/cli", { bin: "x.js" })).toEqual(["cli"]);
    expect(declaredBins("eslint", { bin: { eslint: "x", eslintx: "y" } })).toEqual(["eslint", "eslintx"]);
    expect(declaredBins("left-pad", {})).toEqual([]);
  });

  it("lists the current file's package first, direct dependencies before the rest, installed only", async () => {
    const packages = await loadPackages("/p", "/p/packages/web/src/main.ts", [webConfig]);
    expect(packages).toEqual([
      {
        dir: "packages/web",
        label: "web",
        bins: [{ name: "cli", from: "@prisma/cli" }, { name: "eslint" }, { name: "tsc" }, { name: "vite" }],
      },
      { dir: "", label: "mono", bins: [{ name: "eslint", from: "eslint" }, { name: "cli" }, { name: "tsc" }] },
    ]);
    // A root file puts the root package first.
    expect((await loadPackages("/p", "/p/README.md", [webConfig])).map((p) => p.dir)).toEqual(["", "packages/web"]);
    expect(commands.fsReadDir).not.toHaveBeenCalledWith(expect.not.stringMatching(/node_modules\/\.bin$/));
  });

  it("filters by the typed name and completes with a trailing space", async () => {
    const packages = await loadPackages("/p", "/p/packages/web/src/main.ts", [webConfig]);
    expect(execItems("npx", packages).map((i) => i.label)).toEqual([
      "npx cli",
      "npx eslint",
      "npx tsc",
      "npx vite",
      "npx eslint",
      "npx cli",
      "npx tsc",
    ]);
    const items = execItems("pnpm exec es", packages);
    expect(items.map((i) => [i.label, i.detail, i.completion])).toEqual([
      ["pnpm exec eslint", "web", "pnpm exec eslint "],
      ["pnpm exec eslint", "mono", "pnpm exec eslint "],
    ]);
    expect(execItems("npx c", packages)[0]).toMatchObject({ label: "npx cli", detail: "@prisma/cli · web" });
    expect(execItems("npx eslint --fix", packages)).toEqual([]);
    expect(execItems("npm run", packages)).toEqual([]);
  });

  it("runs through the package manager in the package folder", () => {
    const pkg = { dir: "packages/web", label: "web", bins: [] };
    expect(execConfig(parseExecLine("pnpm exec")!.runner, "vite", ["--host", "a b"], pkg)).toMatchObject({
      name: "web: pnpm exec vite --host 'a b'",
      kind: "npm",
      command: "pnpm",
      args: ["exec", "vite", "--host", "a b"],
      cwd: "packages/web",
    });
    expect(execConfig(parseExecLine("npx")!.runner, "tsc", [], { ...pkg, dir: "" })).toMatchObject({
      name: "npx tsc",
      command: "npx",
      args: ["tsc"],
      cwd: null,
    });
  });

  it("runs a typed line in the first package that has the executable; others go to the shell", async () => {
    useProject.setState({ project: { root: "/p" } as never });
    useRun.setState({ configs: [webConfig] });
    provideEditorService({ activePath: () => "/p/packages/web/src/main.ts" } as unknown as EditorService);
    const run = vi.spyOn(actions, "executeAction").mockResolvedValue(true);
    const changed = vi.fn();
    const unwatch = packageBinsRunAnything.watch!(changed);
    expect(packageBinsRunAnything.items("npx")).toEqual([]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(packageBinsRunAnything.items("npx v").map((i) => i.label)).toEqual(["npx vite"]);

    expect(await packageBinsRunAnything.execute!("npx vite --port '5 1'")).toBe(true);
    expect(run).toHaveBeenLastCalledWith(
      "run.runConfig",
      expect.objectContaining({ command: "npx", args: ["vite", "--port", "5 1"], cwd: "packages/web" }),
    );
    expect(await packageBinsRunAnything.execute!("npx create-vite app")).toBe(false);
    expect(await packageBinsRunAnything.execute!("yarn install")).toBe(false);
    expect(await packageBinsRunAnything.execute!("npx eslint . && echo done")).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    unwatch();
  });
});
