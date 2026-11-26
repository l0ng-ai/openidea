import { beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "@/platform/actions";
import { commands, type FileEntry, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import {
  clearPackageBinsCache,
  declaredBins,
  execConfig,
  execItems,
  loadPackages,
  packageBinsRunAnything,
  parseExecLine,
  watchPackageBinsChanges,
} from "./packageBins";
import { useRun } from "./store";

const events = vi.hoisted(() => new Map<string, (e: unknown) => void>());
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  onIdeEvent: vi.fn((type: string, handler: (e: unknown) => void) => {
    events.set(type, handler);
    return () => events.delete(type);
  }),
}));

// A hoisted workspace: the root and `packages/web`.
const FILES: Record<string, unknown> = {
  "/p/package.json": { name: "mono", devDependencies: { eslint: "9" } },
  "/p/node_modules/eslint/package.json": { bin: { eslint: "bin/eslint.js" } },
  "/p/node_modules/@prisma/cli/package.json": { bin: "build/index.js" },
  "/p/packages/web/package.json": { name: "web", dependencies: { "@prisma/cli": "5", "left-pad": "1" } },
};
const DIRS: Record<string, string[]> = {
  "/p/node_modules": [".bin", "eslint", "@prisma"],
  "/p/node_modules/@prisma": ["cli"],
  // `gone` is a dangling link left by an uninstalled package.
  "/p/node_modules/.bin": ["eslint", "eslint.cmd", "eslint.ps1", "tsc", "cli", "gone"],
  "/p/packages/web/node_modules": [".bin"],
  "/p/packages/web/node_modules/.bin": ["vite", "vite.bunx"],
};
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const missing = { status: "error" as const, error: { kind: "notFound", message: "missing" } as never };
const entry = (name: string) => ({ name, kind: "symlink", targetKind: name === "gone" ? null : "file" }) as FileEntry;
const webConfig = { id: "npm:web:dev", kind: "npm", detected: true, cwd: "packages/web" } as RunConfig;

beforeEach(() => {
  vi.restoreAllMocks();
  clearPackageBinsCache();
  vi.spyOn(commands, "fsReadText").mockImplementation(async (path) =>
    path in FILES ? ok(JSON.stringify(FILES[path])) : missing,
  );
  vi.spyOn(commands, "fsReadDir").mockImplementation(async (path) =>
    path in DIRS ? ok(DIRS[path]!.map(entry)) : missing,
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
    // An absent dependency (`left-pad`) costs no manifest read.
    expect(commands.fsReadText).not.toHaveBeenCalledWith(expect.stringContaining("left-pad"));
  });

  it("reads the disk once until something under node_modules or a package.json changes", async () => {
    const dispose = watchPackageBinsChanges();
    await loadPackages("/p", "/p/packages/web/src/main.ts", [webConfig]);
    const reads = () =>
      vi.mocked(commands.fsReadDir).mock.calls.length + vi.mocked(commands.fsReadText).mock.calls.length;
    const first = reads();
    await loadPackages("/p", "/p/README.md", [webConfig]);
    expect(reads()).toBe(first);
    events.get("fsChanged")!({ created: ["/p/src/a.ts"], modified: [], removed: [] });
    await loadPackages("/p", "/p/README.md", [webConfig]);
    expect(reads()).toBe(first);
    events.get("excludedDirsChanged")!({ dirs: ["/p/node_modules"] });
    await loadPackages("/p", "/p/README.md", [webConfig]);
    expect(reads()).toBeGreaterThan(first);
    dispose();
  });

  it("offers Yarn 2+ only the package's direct dependencies' executables", async () => {
    FILES["/p/.yarnrc.yml"] = "nodeLinker: node-modules";
    try {
      const packages = await loadPackages("/p", "/p/packages/web/src/main.ts", [webConfig]);
      expect(execItems("yarn", packages).map((i) => [i.label, i.detail])).toEqual([
        ["yarn cli", "@prisma/cli · web"],
        ["yarn eslint", "mono"],
      ]);
      expect(execItems("npx", packages)).toHaveLength(7);
    } finally {
      delete FILES["/p/.yarnrc.yml"];
    }
  });

  it("keeps a member folder that starts with a dot", async () => {
    FILES["/p/.storybook/package.json"] = { name: "sb" };
    try {
      const dot = { ...webConfig, cwd: ".storybook" };
      expect((await loadPackages("/p", null, [dot])).map((p) => p.dir)).toEqual(["", ".storybook"]);
    } finally {
      delete FILES["/p/.storybook/package.json"];
    }
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
    const unwatch = packageBinsRunAnything.subscribe!(changed);
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
    const shellLines = [
      "npx eslint . && echo done",
      "npx tsc src/*.ts",
      "npx vite ~/site",
      "npx vite {a,b}",
      "npx vite (x)",
      "npx vite %PORT%",
      "npx vite $PORT",
    ];
    expect(await Promise.all(shellLines.map((l) => packageBinsRunAnything.execute!(l)))).toEqual(
      shellLines.map(() => false),
    );
    expect(run).toHaveBeenCalledTimes(1);
    unwatch();
  });
});
