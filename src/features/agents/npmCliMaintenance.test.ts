// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const helper = readFileSync(fileURLToPath(new URL("./npmCliMaintenance.mjs", import.meta.url)), "utf8");
const cli = "claude";
const pkg = "@anthropic-ai/claude-code";
const windows = process.platform === "win32";
let dir: string;
let prefixName = "global prefix";
const prefix = () => join(dir, prefixName);
const bin = (p: string) => join(p, windows ? "" : "bin", cli + (windows ? ".cmd" : ""));
const folder = (p: string) => join(p, windows ? "" : "lib", "node_modules", pkg);

function installed(p: string, version: string) {
  mkdirSync(folder(p), { recursive: true });
  mkdirSync(dirname(bin(p)), { recursive: true });
  writeFileSync(join(folder(p), "entry.js"), "");
  writeFileSync(join(folder(p), "package.json"), JSON.stringify({ name: pkg, version, bin: { claude: "entry.js" } }));
  if (windows) writeFileSync(bin(p), '@"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\entry.js"');
  else symlinkSync(join(folder(p), "entry.js"), bin(p));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openidea-cli-"));
  prefixName = "global prefix";
  installed(prefix(), "2.1.9");
  const entry = windows ? join(dir, "node_modules/npm/bin/npm-cli.js") : join(dir, "npm.cjs");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `#!/usr/bin/env node
    const fs=require("node:fs"), path=require("node:path"), [cmd,...args]=process.argv.slice(2);
    if(cmd==="prefix")console.log(process.env.TEST_PREFIX);
    else if(cmd==="view")console.log(JSON.stringify(process.env.TEST_LATEST));
    else if(cmd==="install"){
      fs.writeFileSync(process.env.TEST_LOG,JSON.stringify(args));
      const target=args[args.indexOf("--prefix")+1], folder=path.join(target,process.platform==="win32"?"":"lib","node_modules","@anthropic-ai","claude-code");
      fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,"package.json"),JSON.stringify({name:"@anthropic-ai/claude-code",bin:{claude:"entry.js"},version:process.env.TEST_LATEST}));
      fs.writeFileSync(path.join(folder,"entry.js"),"");
      const link=path.join(target,process.platform==="win32"?"":"bin",process.platform==="win32"?"claude.cmd":"claude");fs.mkdirSync(path.dirname(link),{recursive:true});
      if(!fs.existsSync(link))process.platform==="win32"?fs.copyFileSync(path.join(process.env.TEST_PREFIX,"claude.cmd"),link):fs.symlinkSync(path.join(folder,"entry.js"),link);
    }else process.exit(2);
  `,
  );
  chmodSync(entry, 0o755);
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

const defaultNpm = () => join(dir, windows ? "npm.cmd" : "npm.cjs");
type Run = { program?: string; latest?: string; npm?: string };
const output = (update?: object, { program = bin(prefix()), latest = "2.1.12", npm = defaultNpm() }: Run = {}) =>
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      helper,
      "--",
      JSON.stringify({
        pkg,
        command: cli,
        program,
        update,
        npm,
      }),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_PREFIX: prefix(),
        TEST_LATEST: latest,
        TEST_LOG: join(dir, "installed"),
        PATH: dirname(bin(prefix())),
      },
      cwd: dir,
    },
  );
const run = (update?: object, options?: Run) => JSON.parse(output(update, options));
it("checks without installing; updates only the approved prefix and exact version", () => {
  const offer = run();
  expect(offer).toEqual({ status: "available", current: "2.1.9", latest: "2.1.12", prefix: prefix() });
  expect(existsSync(join(dir, "installed"))).toBe(false);
  expect(run(offer).status).toBe("updated");
  expect(run()).toEqual({ status: "current", current: "2.1.12" });
  expect(JSON.parse(readFileSync(join(dir, "installed"), "utf8"))).toContain(pkg + "@2.1.12");
});
it("requires a fresh choice when the registry version changes and never downgrades", () => {
  const offer = run();
  expect(run(offer, { latest: "2.1.13" }).status).toBe("available");
  expect(run(undefined, { latest: "2.0.0" }).status).toBe("current");
  expect(existsSync(join(dir, "installed"))).toBe(false);
});
it("leaves other installations alone", () => {
  const other = join(dir, "claude");
  writeFileSync(other, "");
  expect(run(undefined, { program: other })).toEqual({ status: "unmanaged" });
});
it.skipIf(windows || process.getuid?.() === 0)("does not install into a read-only installation", () => {
  chmodSync(folder(prefix()), 0o555);
  try {
    const offer = run();
    expect(offer).toEqual({ status: "permission", current: "2.1.9", latest: "2.1.12", prefix: prefix() });
    expect(run(offer).status).toBe("permission");
    expect(existsSync(join(dir, "installed"))).toBe(false);
  } finally {
    chmodSync(folder(prefix()), 0o755);
  }
});
it.skipIf(windows)("runs npm through a version manager's shell shim", () => {
  const shim = join(dir, "shims", "npm");
  mkdirSync(dirname(shim));
  writeFileSync(shim, `#!/bin/sh\nexec node "${join(dir, "npm.cjs")}" "$@"\n`);
  chmodSync(shim, 0o755);
  expect(run(undefined, { npm: shim }).status).toBe("available");
});
it("keeps its output ASCII so a non-UTF-8 console cannot change the offered prefix", () => {
  prefixName = "全局 prefix";
  installed(prefix(), "2.1.9");
  const text = output();
  expect(text).toMatch(/^[\x20-\x7e]+\n$/);
  const offer = JSON.parse(text);
  expect(offer.prefix).toBe(prefix());
  expect(run(offer).status).toBe("updated");
});
