/**
 * Jump to Source for a run configuration: the file it runs, as IDEA's run configuration
 * nodes navigate to their main class or script.
 */
import { call, commands, type RunConfig } from "@/platform/ipc";
import { isJvmApplication, parseJavaArgs } from "@/platform/javaLaunch";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { editorService, notifications } from "@/workbench/contributions";
import { joinPath } from "./links";
import { formParams, typeFor } from "./types";

export interface ConfigSource {
  path: string;
  /** 0-based. */
  line: number;
}

/** Kinds whose configurations name a file of the project; others (a JAR, a compound) have none. */
const SOURCE_KINDS = new Set([
  "application",
  "spring-boot",
  "python",
  "pytest",
  "ruby",
  "shell",
  "npm",
  "bun",
  "gradle",
  "maven",
  "go",
  "go-test",
  "dotnet",
  "dotnet-test",
]);

export function hasSource(config: RunConfig): boolean {
  return SOURCE_KINDS.has(config.kind) || isJvmApplication(config);
}

function params(config: RunConfig): Record<string, string> {
  return formParams(config) ?? typeFor(config.kind)?.paramsFrom?.(config) ?? config.params ?? {};
}

async function text(path: string): Promise<string | null> {
  return call(commands.fsReadText(path)).catch(() => null);
}

/** 0-based line of the first match of `pattern` in `source`, else 0. */
function lineOf(source: string, pattern: RegExp): number {
  const m = pattern.exec(source);
  return m ? source.slice(0, m.index).split("\n").length - 1 : 0;
}

async function file(path: string | null, pattern?: RegExp): Promise<ConfigSource | null> {
  if (!path) return null;
  const source = await text(path);
  if (source === null) return null;
  return { path, line: pattern ? lineOf(source, pattern) : 0 };
}

async function firstFile(dir: string, names: string[], pattern?: RegExp): Promise<ConfigSource | null> {
  for (const name of names) {
    const found = await file(joinPath(dir, name), pattern);
    if (found) return found;
  }
  return null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The class's source among the project's files; a Kotlin file class `AppKt` is `App.kt`. */
async function mainClassSource(mainClass: string, module: string): Promise<ConfigSource | null> {
  const name = mainClass.trim();
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  const pkg = dot < 0 ? "" : name.slice(0, dot).replaceAll(".", "/");
  const simple = name.slice(dot + 1).split("$")[0]!;
  const fileClass = simple.endsWith("Kt") ? simple.slice(0, -2) : null;
  const names = [`${simple}.java`, `${simple}.kt`, ...(fileClass ? [`${fileClass}.kt`] : [])];
  const found = (await Promise.all(names.map((n) => call(commands.findFilesNamed(n)).catch(() => [])))).flat();
  const suffix = (n: string) => (pkg ? `/${pkg}/${n}` : `/${n}`);
  const matching = found.filter((p) => names.some((n) => p.replace(/\\/g, "/").endsWith(suffix(n))));
  // Several modules may declare the class: the configuration's module wins.
  const inModule = module
    ? matching.filter((p) => p.replace(/\\/g, "/").startsWith(`${module.replace(/\/+$/, "")}/`))
    : [];
  const path = inModule[0] ?? matching[0];
  if (!path) return null;
  const declaration = path.endsWith(`${fileClass}.kt`)
    ? /^[ \t]*fun\s+main\b/m
    : new RegExp(String.raw`\b(class|interface|enum|record|object)\s+${escape(simple)}\b`);
  return file(path, declaration);
}

/** The file `config` runs (main class, script, package.json script, build file), if any. */
export async function configSource(config: RunConfig): Promise<ConfigSource | null> {
  const root = useProject.getState().project?.root ?? "";
  const cwd = config.cwd ?? root;
  const p = params(config);
  const at = (path: string | undefined, base = cwd) => (path?.trim() ? joinPath(base, path.trim()) : null);
  if (isJvmApplication(config)) {
    const module = config.module ? joinPath(root, config.module) : "";
    return mainClassSource(p.mainClass || parseJavaArgs(config.args).mainClass || "", module);
  }
  switch (config.kind) {
    case "python":
      if (p.mode === "module" && p.module) {
        const rel = p.module.replaceAll(".", "/");
        return firstFile(cwd, [`${rel}.py`, `${rel}/__main__.py`]);
      }
      return file(at(p.script));
    case "pytest":
      return file(at(p.target?.split("::")[0]));
    case "ruby":
      return file(at(p.script));
    case "shell":
      return p.mode === "file" ? file(at(p.path)) : null;
    case "npm":
    case "bun": {
      const dir = at(p.packageDir) ?? cwd;
      const script = p.script?.trim();
      return file(joinPath(dir, "package.json"), script ? new RegExp(`"${escape(script)}"\\s*:`) : undefined);
    }
    case "gradle":
      return firstFile(at(p.projectDir) ?? cwd, [
        "build.gradle.kts",
        "build.gradle",
        "settings.gradle.kts",
        "settings.gradle",
      ]);
    case "maven":
      return firstFile(at(p.projectDir) ?? cwd, ["pom.xml"]);
    case "go":
    case "go-test": {
      const target = at(p.target);
      if (target && /\.go$/.test(target)) return file(target);
      return firstFile(target ?? cwd, ["main.go"]);
    }
    case "dotnet":
    case "dotnet-test":
      return file(at(p.project));
    default:
      return null;
  }
}

export async function jumpToConfigSource(config: RunConfig): Promise<void> {
  const source = await configSource(config);
  if (!source) {
    notifications().notify({
      group: "run",
      level: "info",
      title: tx`Cannot find the source of ${config.name}`,
    });
    return;
  }
  await editorService().openFile(source.path, { selection: { line: source.line, col: 0 }, focus: true });
}
