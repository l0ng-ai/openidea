/**
 * Jump to Source for Docker Compose services and containers: resolves the
 * container's `composeFiles` / `composeWorkingDir` and opens the Compose YAML
 * file at the service declaration, or (from the dashboard's Command row) at
 * `services.<service>.command`, else `entrypoint`, else the declaration.
 */
import { editorsFor } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { call, commands, type DockerContainer } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { editorService, notifications } from "@/workbench/contributions";

/** Where to land in a service: its `command` (else `entrypoint`), or its declaration. */
export type ComposeTarget = "command" | "service";

export interface ComposeCommandLocation {
  kind: "command" | "entrypoint" | "service" | "services" | "file";
  /** 0-based line index. */
  line: number;
  /** 0-based UTF-16 column index. */
  col: number;
}

const DEFAULT_COMPOSE_FILENAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;

const BLOCK_SCALAR_HEADER = /^[|>](?:[+-]?\d*|\d+[+-]?)$/;

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

const normalizeSlashes = (p: string) => p.replace(/\\/g, "/");

function joinDirAndFile(dir: string, file: string): string {
  const cleanDir = normalizeSlashes(dir).replace(/\/+$/, "");
  const cleanFile = normalizeSlashes(file).replace(/^(?:\.\/)+/, "");
  if (!cleanDir) return cleanFile;
  return `${cleanDir}/${cleanFile}`;
}

export function hasComposeSource(
  container: Pick<DockerContainer, "composeProject" | "composeWorkingDir" | "composeFiles">,
): boolean {
  return Boolean(container.composeFiles.length || (container.composeProject && container.composeWorkingDir));
}

/**
 * Candidate Compose file paths in evaluation order (base files first, override files last),
 * resolved against `composeWorkingDir` or `projectRoot` when relative.
 */
export function resolveComposeFilePaths(
  composeFiles: readonly string[],
  composeWorkingDir: string | null,
  projectRoot: string | null = null,
): string[] {
  const baseDir = composeWorkingDir?.trim() || projectRoot?.trim() || "";
  const seen = new Set<string>();
  const add = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const normalized = normalizeSlashes(trimmed);
    const full = isAbsolute(normalized) ? normalized : baseDir ? joinDirAndFile(baseDir, normalized) : null;
    if (full && !seen.has(full)) seen.add(full);
  };
  if (composeFiles.length > 0) {
    for (const f of composeFiles) add(f);
  } else if (composeWorkingDir?.trim()) {
    for (const name of DEFAULT_COMPOSE_FILENAMES) add(joinDirAndFile(composeWorkingDir.trim(), name));
  }
  return [...seen];
}

/** Strip `# ...` comments outside of single/double quotes. */
function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function valuePositionAt(
  lines: readonly string[],
  propLine: number,
  propIndent: number,
  codeAfterColon: string,
  colonEndCol: number,
): { line: number; col: number } {
  const trimmed = codeAfterColon.trim();
  if (trimmed && !BLOCK_SCALAR_HEADER.test(trimmed)) {
    const leadWs = codeAfterColon.length - codeAfterColon.trimStart().length;
    return { line: propLine, col: colonEndCol + leadWs };
  }
  if (BLOCK_SCALAR_HEADER.test(trimmed)) {
    for (let k = propLine + 1; k < lines.length; k++) {
      const raw = lines[k]!.replace(/\r$/, "");
      if (!raw.trim()) continue;
      const rawLead = raw.length - raw.trimStart().length;
      if (rawLead <= propIndent) break;
      return { line: k, col: rawLead };
    }
    return { line: propLine, col: propIndent };
  }
  for (let k = propLine + 1; k < lines.length; k++) {
    const raw = lines[k]!.replace(/\r$/, "");
    const code = stripInlineComment(raw);
    if (!code.trim()) continue;
    const lead = code.length - code.trimStart().length;
    if (lead < propIndent) break;
    const seqMatch = /^(\s*-\s+)(.*)$/.exec(code);
    if (seqMatch) {
      const itemText = seqMatch[2]!.trim();
      if (BLOCK_SCALAR_HEADER.test(itemText)) {
        const dashIndent = lead;
        for (let m = k + 1; m < lines.length; m++) {
          const scriptRaw = lines[m]!.replace(/\r$/, "");
          if (!scriptRaw.trim()) continue;
          const scriptLead = scriptRaw.length - scriptRaw.trimStart().length;
          if (scriptLead <= dashIndent) break;
          return { line: m, col: scriptLead };
        }
      }
      return { line: k, col: seqMatch[1]!.length };
    }
    if (lead === propIndent) break;
    return { line: k, col: lead };
  }
  return { line: propLine, col: propIndent };
}

/**
 * Locates `services.<service>.command` (preferred), `services.<service>.entrypoint`,
 * or the `services.<service>` declaration in a Compose YAML document.
 * When `service` is null, locates the top-level `services:` section.
 */
export function locateComposeServiceCommand(
  text: string,
  service: string | null,
  at: ComposeTarget = "command",
): ComposeCommandLocation | null {
  const lines = text.split("\n");
  let inServices = false;
  let serviceIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const code = stripInlineComment(lines[i]!.replace(/\r$/, ""));
    if (!code.trim()) continue;
    const lead = code.length - code.trimStart().length;
    if (lead === 0) {
      const top = /^([A-Za-z0-9._-]+)\s*:/.exec(code)?.[1];
      if (top === "services") {
        if (!service) return { kind: "services", line: i, col: 0 };
        inServices = true;
        serviceIndent = null;
      } else {
        inServices = false;
        serviceIndent = null;
      }
      continue;
    }
    if (!inServices || !service) continue;
    serviceIndent ??= lead;
    if (lead !== serviceIndent) continue;

    const svcMatch = /^(\s*)("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:/.exec(code);
    if (!svcMatch) continue;
    const svcName = (svcMatch[3] ?? svcMatch[4] ?? svcMatch[5])!;
    if (svcName !== service) continue;

    const rawToken = svcMatch[2]!;
    const svcCol = svcMatch[1]!.length + (rawToken.startsWith('"') || rawToken.startsWith("'") ? 1 : 0);
    const serviceLoc: ComposeCommandLocation = { kind: "service", line: i, col: svcCol };
    if (at === "service") return serviceLoc;

    let propIndent: number | null = null;
    let commandLoc: ComposeCommandLocation | null = null;
    let entrypointLoc: ComposeCommandLocation | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      const propCode = stripInlineComment(lines[j]!.replace(/\r$/, ""));
      if (!propCode.trim()) continue;
      const propLead = propCode.length - propCode.trimStart().length;
      if (propLead <= serviceIndent) break;

      const keyMatch = /^(\s*)("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:(.*)$/.exec(propCode);
      if (!keyMatch) continue;
      if (propIndent === null || propLead < propIndent) propIndent = propLead;
      if (propLead !== propIndent) continue;

      const propName = (keyMatch[3] ?? keyMatch[4] ?? keyMatch[5])!;
      if (propName !== "command" && propName !== "entrypoint") continue;

      const afterColon = keyMatch[6] ?? "";
      const colonEndCol = propCode.length - afterColon.length;
      const pos = valuePositionAt(lines, j, propIndent, afterColon, colonEndCol);
      if (propName === "command") commandLoc = { kind: "command", ...pos };
      else entrypointLoc = { kind: "entrypoint", ...pos };
    }

    return commandLoc ?? entrypointLoc ?? serviceLoc;
  }

  return service ? null : { kind: "file", line: 0, col: 0 };
}

/**
 * Picks the active Compose file and caret position across ordered Compose files
 * (later override files take precedence when they define `command` or `entrypoint`).
 */
export function pickComposeCommandLocation(
  files: ReadonlyArray<{ path: string; text: string }>,
  service: string | null,
  at: ComposeTarget = "command",
): (ComposeCommandLocation & { path: string }) | null {
  if (!files.length) return null;
  if (!service) {
    for (const f of files) {
      const loc = locateComposeServiceCommand(f.text, null);
      if (loc && loc.kind === "services") return { path: f.path, ...loc };
    }
    return { path: files[0]!.path, kind: "file", line: 0, col: 0 };
  }
  for (let i = files.length - 1; at === "command" && i >= 0; i--) {
    const f = files[i]!;
    const loc = locateComposeServiceCommand(f.text, service);
    if (loc && (loc.kind === "command" || loc.kind === "entrypoint")) {
      return { path: f.path, ...loc };
    }
  }
  for (const f of files) {
    const loc = locateComposeServiceCommand(f.text, service, at);
    if (loc) return { path: f.path, ...loc };
  }
  return { path: files[0]!.path, kind: "file", line: 0, col: 0 };
}

async function readComposeFileText(path: string): Promise<string | null> {
  const open = editorsFor(path)[0];
  if (open) return open.view.state.doc.toString();
  try {
    return await call(commands.fsReadText(path));
  } catch {
    return null;
  }
}

async function loadReadableComposeFiles(
  composeFiles: readonly string[],
  composeWorkingDir: string | null,
): Promise<Array<{ path: string; text: string }>> {
  const root = useProject.getState().project?.root ?? null;
  const candidates = resolveComposeFilePaths(composeFiles, composeWorkingDir, root);
  const loaded = await Promise.all(
    candidates.map(async (path) => {
      const text = await readComposeFileText(path);
      return text !== null ? { path, text } : null;
    }),
  );
  return loaded.filter((x): x is { path: string; text: string } => x !== null);
}

export async function jumpToContainerComposeSource(
  container: DockerContainer,
  at: ComposeTarget = "service",
): Promise<void> {
  const files = await loadReadableComposeFiles(container.composeFiles, container.composeWorkingDir);
  const target = pickComposeCommandLocation(files, container.composeService, at);
  if (!target) {
    notifications().notify({
      group: "run",
      level: "info",
      title: tx`Cannot find the source of ${container.name}`,
    });
    return;
  }
  await editorService().openFile(target.path, {
    selection: { line: target.line, col: target.col },
    focus: true,
  });
}

export async function jumpToComposeProjectSource(
  project: string,
  containers: readonly DockerContainer[],
): Promise<void> {
  const first = containers[0];
  const files = first ? await loadReadableComposeFiles(first.composeFiles, first.composeWorkingDir) : [];
  const target = pickComposeCommandLocation(files, null);
  if (!target) {
    notifications().notify({
      group: "run",
      level: "info",
      title: tx`Cannot find the source of ${project}`,
    });
    return;
  }
  await editorService().openFile(target.path, {
    selection: { line: target.line, col: target.col },
    focus: true,
  });
}

export async function openComposeFile(file: string, composeWorkingDir: string | null): Promise<void> {
  const files = await loadReadableComposeFiles([file], composeWorkingDir);
  if (!files.length) {
    notifications().notify({
      group: "run",
      level: "info",
      title: tx`Cannot find the source of ${file}`,
    });
    return;
  }
  await editorService().openFile(files[0]!.path, { focus: true });
}
