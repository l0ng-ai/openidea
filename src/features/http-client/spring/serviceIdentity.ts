/** Bounded local configuration evidence, never an effective runtime identity. */
import { isErrorKind, type FileEntry } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";

export interface ServiceReader {
  directory(path: string): Promise<FileEntry[]>;
  read(path: string): Promise<string>;
}

export function sourceModule(path: string): string | null {
  return /^(.*)\/src\/main\/(?:java|kotlin)\//.exec(ipcPath(path))?.[1] ?? null;
}

export function isServiceConfiguration(path: string): boolean {
  return /\/(?:application|bootstrap)(?:-[^/]+)?\.(?:properties|ya?ml)$/.test(ipcPath(path));
}

interface Evidence {
  names: string[];
  base: boolean;
  unresolved: boolean;
}

/** Keep duplicate keys and reject YAML features whose property sources we cannot establish. */
function evidence(name: string, text: string): Evidence {
  const entries: [string, string][] = [];
  const stack: { indent: number; key: string }[] = [];
  let unresolved = false;
  let blockIndent: number | null = null;
  const properties = name.endsWith(".properties");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent !== null) {
      if (!line || indent > blockIndent) continue;
      blockIndent = null;
    }
    if (/^(?:---|\.\.\.|#---|!---)(?:\s|$)/.test(line)) unresolved = true;
    if (!line || line.startsWith("#") || (properties && line.startsWith("!"))) continue;
    if (properties) {
      if (line.endsWith("\\")) unresolved = true;
      const match = /^((?:\\.|[^=:\s])+)\s*[=:\s]\s*(.*)$/.exec(line);
      if (match) {
        unresolved ||= match[1]!.includes("\\");
        entries.push([match[1]!, match[2]!.trim()]);
      }
      continue;
    }
    if (/^\s*<<\s*:/.test(raw) || /^\s*\t/.test(raw) || /^[{[&*!]/.test(line)) unresolved = true;
    const match = /^( *)("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(raw);
    if (!match) continue;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const key = match[2]!.replace(/^["']|["']$/g, "");
    unresolved ||= key.includes("\\");
    const path = [...stack.map((s) => s.key), key].join(".");
    const value = (match[3] ?? "").replace(/\s+#.*$/, "").trim();
    entries.push([path, value.replace(/^"([^"\\]*)"$|^'([^']*)'$/, "$1$2")]);
    if (!value) stack.push({ indent, key });
    if (/^[|>][+-]?\d?$/.test(value)) blockIndent = indent;
    if (["spring", "spring.application", "spring.config"].includes(path) && value) unresolved = true;
  }
  const names = entries.filter(([key]) => key === "spring.application.name").map(([, value]) => value);
  unresolved ||= names.length > 1 || names.some((value) => !/^[\w.-]{1,255}$/.test(value));
  unresolved ||= entries.some(([key]) => /^spring\.config\.(?:import|location|additional-location|name)$/.test(key));
  const conditional = entries.some(([key]) => key === "spring.profiles" || key.startsWith("spring.config.activate."));
  return { names, unresolved, base: /^application\.(?:properties|ya?ml)$/.test(name) && !conditional };
}

/** Only this module's resources, including its config/ directory; never parent or test resources. */
export async function loadServiceName(module: string, reader: ServiceReader): Promise<string | null> {
  const sources: Evidence[] = [];
  let count = 0,
    bytes = 0;
  const main = `${module}/src/main`;
  let children: FileEntry[];
  try {
    children = await reader.directory(main);
  } catch {
    return null;
  }
  for (const [parent, name] of [
    [main, "resources"],
    [`${main}/resources`, "config"],
  ]) {
    const directory = `${parent}/${name}`;
    const entry = children.find((file) => file.name === name);
    if (!entry) break;
    if (entry.kind !== "dir" || entry.ignored || entry.excluded || ipcPath(entry.path) !== directory) return null;
    let entries: FileEntry[];
    try {
      entries = await reader.directory(directory);
    } catch (error) {
      if (isErrorKind(error, "notFound")) continue;
      return null;
    }
    for (const file of entries) {
      if (!isServiceConfiguration(`/${file.name}`)) continue;
      // Do not follow configuration symlinks or read excluded files as evidence.
      if (
        file.kind !== "file" ||
        file.ignored ||
        file.excluded ||
        file.name.includes("/") ||
        file.name.includes("\\") ||
        ipcPath(file.path) !== `${directory}/${file.name}` ||
        file.size > 128 * 1024 ||
        ++count > 32
      )
        return null;
      let text: string;
      try {
        text = await reader.read(file.path);
      } catch {
        return null;
      }
      bytes += text.length;
      if (text.length > 128 * 1024 || bytes > 1024 * 1024) return null;
      sources.push(evidence(file.name, text));
    }
    children = entries;
  }
  if (sources.some((s) => s.unresolved) || !sources.some((s) => s.base && s.names.length === 1)) return null;
  const names = new Set(sources.flatMap((s) => s.names));
  return names.size === 1 ? [...names][0]! : null;
}
