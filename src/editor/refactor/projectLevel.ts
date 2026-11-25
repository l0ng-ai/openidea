/**
 * Language levels read from build files, for templates that depend on them:
 * Java `var` (10+) from Maven / Gradle, C `auto` (C23) from CMake / compiler
 * flags. Unknown means "not known to be supported".
 */
import { call, commands } from "@/platform/ipc";

/** `1.8` → 8, `17` → 17. */
export function parseJavaVersion(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = /^\s*(?:1\.)?(\d+)/.exec(v);
  return m ? Number(m[1]) : null;
}

function pomProperties(pom: string): Map<string, string> {
  const props = new Map<string, string>();
  const section = /<properties>([\s\S]*?)<\/properties>/.exec(pom)?.[1] ?? "";
  for (const m of section.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(m[1]!, m[2]!);
  return props;
}

function resolve(value: string | undefined, props: Map<string, string>, depth = 0): string | undefined {
  if (!value || depth > 5) return value;
  const ref = /^\$\{([\w.-]+)\}$/.exec(value.trim());
  return ref ? resolve(props.get(ref[1]!), props, depth + 1) : value;
}

/** Java language level declared by a pom.xml, if any. */
export function javaLevelFromPom(pom: string): number | null {
  const clean = pom.replace(/<!--[\s\S]*?-->/g, "");
  const props = pomProperties(clean);
  const plugin = /<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>([\s\S]*?)<\/plugin>/.exec(clean)?.[1] ?? "";
  const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(plugin)?.[1];
  const candidates = [
    tag("release"),
    props.get("maven.compiler.release"),
    tag("source"),
    props.get("maven.compiler.source"),
    props.get("java.version"),
  ];
  for (const c of candidates) {
    const v = parseJavaVersion(resolve(c, props));
    if (v !== null) return v;
  }
  return null;
}

/** Java language level declared by a build.gradle(.kts), if any. */
export function javaLevelFromGradle(gradle: string): number | null {
  const clean = gradle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const patterns = [
    /options\.release(?:\.set\s*\(|\s*=)\s*(\d+)/,
    /JavaLanguageVersion\.of\s*\(\s*["']?(\d+)/,
    /jvmToolchain\s*\(\s*(\d+)/,
    /sourceCompatibility\s*(?:=|\s)\s*(?:JavaVersion\.VERSION_(?:1_)?(\d+)|["']?((?:1\.)?\d+)["']?)/,
    /JavaVersion\.VERSION_(?:1_)?(\d+)/,
  ];
  for (const p of patterns) {
    const m = p.exec(clean);
    if (m) return parseJavaVersion(m[1] ?? m[2]);
  }
  return null;
}

/** C23 (`auto` type inference) requested by CMake or compiler flags. */
export function cStandardIs23(file: string, text: string): boolean {
  if (/CMakeLists\.txt$/.test(file)) return /C_STANDARD\s+(23|2x)\b/i.test(text) || /-std=(c|gnu)(23|2x)\b/.test(text);
  return /-std=(c|gnu)(23|2x)\b/.test(text);
}

type ReadText = (path: string) => Promise<string>;

const readText: ReadText = (path) => call(commands.fsReadText(path));

function parentDir(path: string): string | null {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

/** Directories from `file`'s up to `root` (inclusive), nearest first. */
export function ancestorDirs(file: string, root: string | null): string[] {
  const out: string[] = [];
  let dir = parentDir(file);
  const stop = root?.replace(/\/+$/, "");
  while (dir) {
    out.push(dir);
    if (!stop || dir === stop || !dir.startsWith(stop)) break;
    dir = parentDir(dir);
  }
  return out;
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearLevelCache() {
  cache.clear();
}

/** Nearest declared Java level for `file` (walking up to `root`), or null. */
export function javaLanguageLevel(
  file: string,
  root: string | null,
  read: ReadText = readText,
): Promise<number | null> {
  return cached(`java:${file}`, async () => {
    for (const dir of ancestorDirs(file, root)) {
      for (const [name, parse] of [
        ["pom.xml", javaLevelFromPom],
        ["build.gradle", javaLevelFromGradle],
        ["build.gradle.kts", javaLevelFromGradle],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- nearest directory and first parser with a level win
        const text = await read(`${dir}/${name}`).catch(() => null);
        if (text === null) continue;
        const level = parse(text);
        if (level !== null) return level;
      }
    }
    return null;
  });
}

/** Whether the C file is built as C23 (per the nearest build configuration found). */
export function cIsC23(file: string, root: string | null, read: ReadText = readText): Promise<boolean> {
  return cached(`c:${file}`, async () => {
    for (const dir of ancestorDirs(file, root)) {
      for (const name of ["CMakeLists.txt", "compile_flags.txt", "compile_commands.json", ".clangd", "Makefile"]) {
        // oxlint-disable-next-line no-await-in-loop -- nearest directory wins; stop at the first C23 config
        const text = await read(`${dir}/${name}`).catch(() => null);
        if (text !== null && cStandardIs23(name, text)) return true;
      }
    }
    return false;
  });
}
