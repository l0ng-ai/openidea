// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeUnselected,
  filterPattern,
  importClosure,
  readWorkflow,
  rustSmokeInputs,
  selectedLanguages,
  smokeInputs,
  unselected,
  type Workflow,
} from "./smoke-paths.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the Language smoke workflow", () => {
  const workflow = readWorkflow(repo);

  it("runs every language when a file the frontend smoke loads changes", async () => {
    const { files, problems } = await smokeInputs(repo, workflow);
    expect(problems).toEqual([]);
    expect(describeUnselected(await unselected(workflow, [...files.keys()]), files)).toBe("");
  }, 20000);

  it("runs every language when a crate the smoke runs changes", async () => {
    const crates = rustSmokeInputs(repo);
    expect(describeUnselected(await unselected(workflow, [...crates.keys()]), crates)).toBe("");
  }, 20000);
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "smoke-paths-test-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const options = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  allowImportingTsExtensions: true,
};

describe("importClosure", () => {
  it("follows every kind of import to repository files, once each", () => {
    const root = scratch({
      "smoke/entry.ts": [
        'import { a } from "../src/a";',
        'import type { T } from "@/types";',
        'export * from "../src/reexported";',
        'import { invoke } from "pkg/core";',
        'import external from "ext";',
        'import { readFileSync } from "node:fs";',
        'import raw from "../src/data.txt?raw";',
        'import styles from "../src/x.module.css";',
        'const lazy = () => import("../src/lazy");',
        'const icons = import.meta.glob(["../src/icons/*.svg", "!../src/icons/none.svg"]);',
        'const worker = new URL("../src/worker.ts", import.meta.url);',
        'const folder = new URL("../src", import.meta.url);',
      ].join("\n"),
      "src/a.ts": 'import { b } from "./b";\nexport const a = 1;',
      "src/b.ts": 'import { a } from "./a";\nimport "./dir";\nexport const b = a;',
      "src/dir/index.ts": "export {};",
      "src/types.ts": "export type T = 1;",
      "src/core.ts": "export const invoke = 1;",
      "src/reexported.ts": "export const r = 1;",
      "src/data.txt": "raw",
      "src/x.module.css": '@import "./tokens.css";\n@import url("https://example.com/font.css");',
      "src/tokens.css": ":root {}",
      "src/lazy.ts": "export {};",
      "src/icons/a.svg": "<svg/>",
      "src/worker.ts": "export {};",
      "src/unused.ts": "export {};",
      "node_modules/ext/package.json": '{ "name": "ext", "main": "index.js" }',
      "node_modules/ext/index.js": "export default 1;",
    });
    const alias = [
      { find: "@", replacement: join(root, "src") },
      { find: /^pkg\/core$/, replacement: join(root, "src/core.ts") },
    ];
    const { files, problems } = importClosure(root, ["smoke/entry.ts"], alias, options);
    expect(problems).toEqual([]);
    expect([...files.keys()]).toEqual([
      "smoke/entry.ts",
      "src/a.ts",
      "src/b.ts",
      "src/core.ts",
      "src/data.txt",
      "src/dir/index.ts",
      "src/icons/a.svg",
      "src/lazy.ts",
      "src/reexported.ts",
      "src/tokens.css",
      "src/types.ts",
      "src/worker.ts",
      "src/x.module.css",
    ]);
    expect(files.get("src/b.ts")).toBe("imported by src/a.ts");
  });

  it("reports imports it cannot follow instead of skipping them", () => {
    const root = scratch({
      "entry.ts": ['import "./missing";', "import(name);", 'import "not-installed";'].join("\n"),
    });
    expect(importClosure(root, ["entry.ts"], [], options).problems).toEqual([
      'entry.ts: cannot resolve "./missing"',
      "entry.ts: import() of a computed specifier",
      'entry.ts: cannot resolve "not-installed" (not a local file, not an installed package)',
    ]);
  });
});

describe("GitHub path filters", () => {
  it("match * within a directory and ** across directories", () => {
    expect(filterPattern("src/*.ts").test("src/a.ts")).toBe(true);
    expect(filterPattern("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(filterPattern("src/**").test("src/a/b.ts")).toBe(true);
    expect(filterPattern("package.json").test("packageXjson")).toBe(false);
  });

  it("refuse syntax the check does not model", () => {
    expect(() => filterPattern("!src/**")).toThrow();
    expect(() => filterPattern("src/?.ts")).toThrow();
  });
});

describe("the Changes step", () => {
  // The shape of language-smoke.yml's step, with a POSIX class JavaScript reads differently.
  const step = (arms: string) => `
    set -euo pipefail
    all="a b"
    emit() { tr ' ' '\\n' <<< "$1" | { grep . || true; } | sort -u | jq -Rsc 'split("\\n") | map(select(. != ""))'; }
    if [ "$GITHUB_EVENT_NAME" != pull_request ]; then echo "languages=$(emit "$all")" >> "$GITHUB_OUTPUT"; exit 0; fi
    gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files" > files.txt
    unused='^src/gen/'
    smoke='^src/([[:alpha:]]+\\.ts$|gen/)|^lib/'
    langs=""
    while read -r f; do
      case "$f" in
        ${arms}
        *) if grep -Eq "$smoke" <<< "$f" && ! grep -Eq "$unused" <<< "$f"; then langs="$all"; break; fi ;;
      esac
    done < files.txt
    echo "languages=$(emit "$langs")" >> "$GITHUB_OUTPUT"`;
  const workflow = (arms = 'src/only-a.ts) langs+=" a" ;;'): Workflow => ({
    on: { pull_request: { paths: ["src/**", "lib/*.ts"] }, push: { paths: ["src/**"] } },
    jobs: { changes: { steps: [{ id: "classify", run: step(arms) }] } },
  });

  it("is run as written, with grep -E", async () => {
    expect(await selectedLanguages(workflow(), ["src/app.ts", "src/app2.ts", "src/only-a.ts"])).toEqual(
      new Map([
        ["src/app.ts", ["a", "b"]],
        ["src/app2.ts", []],
        ["src/only-a.ts", ["a"]],
      ]),
    );
  });

  it("decides with the path filters which paths could skip a language", async () => {
    const reasons = await unselected(workflow(), [
      "src/app.ts",
      "src/app2.ts",
      "src/gen/x.ts",
      "lib/x.ts",
      "lib/a/x.ts",
    ]);
    expect(reasons).toEqual(
      new Map([
        ["src/app2.ts", ['not matched by "smoke" in the Changes step']],
        ["src/gen/x.ts", ['matched by "unused" in the Changes step']],
        ["lib/x.ts", ["not in on.push.paths"]],
        ["lib/a/x.ts", ["not in on.pull_request.paths", "not in on.push.paths"]],
      ]),
    );
  });

  it("fails when a case arm sends a path elsewhere than its patterns say", async () => {
    await expect(unselected(workflow("src/app.ts) ;;"), ["src/app.ts"])).rejects.toThrow(
      /for src\/app\.ts the Changes step runs no language/,
    );
  });
});
