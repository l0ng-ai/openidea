/** The machine and tools a report was measured with: a baseline only holds for the same ones. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";

export interface Fingerprint {
  cpu: string;
  cores: number;
  memoryGb: number;
  os: string;
}

export function fingerprint(): Fingerprint {
  return {
    cpu: cpus()[0]?.model.trim() ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()} ${arch()}`,
  };
}

export function sameMachine(a: Fingerprint | undefined, b: Fingerprint): boolean {
  return !!a && a.cpu === b.cpu && a.cores === b.cores && a.memoryGb === b.memoryGb && a.os === b.os;
}

/** `KEY=value` lines (`#` comments), as GitHub Actions' `$GITHUB_ENV` takes them; keys lower-cased. */
export function pinnedTools(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(\S+)/.exec(line);
    if (m) out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

function which(cmd: string): string | null {
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" })
      .split("\n")[0]!
      .trim();
    return found ? realpathSync(found) : null;
  } catch {
    return null;
  }
}

/** jdtls's version from its core bundle (`org.eclipse.jdt.ls.core_1.63.0.202610191322.jar` → `1.63.0-202610191322`). */
function jdtlsVersion(): string | null {
  const bin = which("jdtls");
  if (!bin) return null;
  for (let dir = dirname(bin), i = 0; i < 4; dir = dirname(dir), i++) {
    for (const plugins of [join(dir, "plugins"), join(dir, "libexec", "plugins")]) {
      if (!existsSync(plugins)) continue;
      const core = readdirSync(plugins).find((f) => /^org\.eclipse\.jdt\.ls\.core_.*\.jar$/.test(f));
      const m = core && /_(\d+\.\d+\.\d+)\.(\d+)\.jar$/.exec(core);
      if (m) return `${m[1]}-${m[2]}`;
    }
  }
  return null;
}

/**
 * The JDK projects compile against, whose sources library navigation opens: `JAVA_HOME`'s (it
 * wins for its Java version; jdtls itself runs on a newer one when it needs to), else the `java`
 * on PATH. Runtime version and vendor (`-XshowSettings` prints to stderr).
 */
function javaVersion(): string | null {
  const home = process.env.JAVA_HOME;
  const java = home ? join(home, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
  const r = spawnSync(java, ["-XshowSettings:properties", "-version"], { encoding: "utf8" });
  const props = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const version = /java\.runtime\.version = (\S+)/.exec(props)?.[1];
  const vendor = /java\.vendor = (.+)/.exec(props)?.[1]?.trim();
  return version ? `${version}${vendor ? ` (${vendor})` : ""}` : null;
}

export function toolVersions(): Record<string, string> {
  const tools: Record<string, string> = {};
  const jdtls = jdtlsVersion();
  if (jdtls) tools.jdtls = jdtls;
  const java = javaVersion();
  if (java) tools.java = java;
  return tools;
}
