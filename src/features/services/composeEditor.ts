/**
 * Docker Compose editor support: completes and navigates (`⌘`-click / `⌘B`)
 * internal references (`depends_on`, `links`, `volumes_from`, `extends.service`,
 * `networks`, `volumes`, `configs`, `secrets`) to their declarations in the
 * Compose file. Schema completion and validation come from `yaml-language-server`
 * (`languages/yaml.toml`, `ide-sdk::apply` and `ide-lsp::compose`).
 */
import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CONTRIBUTED_DEFINITION, type ContributedDefinition, type EditorDocContext } from "@/editor/api";
import { isComposeFile, isYamlFile } from "./compose";

// ---------------------------------------------------------------------------
// Compose declarations & internal reference resolution

export interface ComposeDeclaration {
  name: string;
  line: number;
  from: number;
  to: number;
}

export interface ComposeDocumentModel {
  services: Map<string, ComposeDeclaration>;
  networks: Map<string, ComposeDeclaration>;
  volumes: Map<string, ComposeDeclaration>;
  configs: Map<string, ComposeDeclaration>;
  secrets: Map<string, ComposeDeclaration>;
}

/** Strip `# ...` comments outside of single/double quotes. */
function stripInlineComment(line: string): { code: string; commentStart: number | null } {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return { code: line.slice(0, i), commentStart: i };
    }
  }
  return { code: line, commentStart: null };
}

export function parseComposeDocument(text: string): ComposeDocumentModel {
  const model: ComposeDocumentModel = {
    services: new Map(),
    networks: new Map(),
    volumes: new Map(),
    configs: new Map(),
    secrets: new Map(),
  };
  const lines = text.split("\n");
  let offset = 0;
  let section: keyof ComposeDocumentModel | null = null;
  let sectionChildIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/\r$/, "");
    const { code } = stripInlineComment(line);
    if (code.trim()) {
      const lead = code.length - code.trimStart().length;
      if (lead === 0) {
        const m = /^([A-Za-z0-9._-]+)\s*:/.exec(code);
        const top = m?.[1];
        if (top === "services" || top === "networks" || top === "volumes" || top === "configs" || top === "secrets") {
          section = top;
          sectionChildIndent = null;
        } else {
          section = null;
          sectionChildIndent = null;
        }
      } else if (section) {
        sectionChildIndent ??= lead;
        if (lead === sectionChildIndent) {
          const m = /^(\s*)("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:/.exec(code);
          if (m) {
            const name = (m[3] ?? m[4] ?? m[5])!;
            const rawToken = m[2]!;
            const from = offset + m[1]!.length + (rawToken.startsWith('"') || rawToken.startsWith("'") ? 1 : 0);
            const to = from + name.length;
            model[section].set(name, { name, line: i, from, to });
          }
        }
      }
    }
    offset += raw.length + 1;
  }
  return model;
}

function ancestorPathAt(
  lines: readonly string[],
  lineIndex: number,
  targetIndent: number,
): { path: string[]; parentLine: number } {
  const path: string[] = [];
  let curIndent = targetIndent;
  let parentLine = -1;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const { code } = stripInlineComment(lines[i]!.replace(/\r$/, ""));
    if (!code.trim()) continue;
    const rawLead = code.length - code.trimStart().length;
    const listMatch = /^(\s*)-\s+("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:/.exec(code);
    if (listMatch) {
      const keyIndent = listMatch[1]!.length + 2;
      if (keyIndent < curIndent) {
        const key = (listMatch[3] ?? listMatch[4] ?? listMatch[5])!;
        path.unshift(key);
        if (parentLine < 0) parentLine = i;
        curIndent = listMatch[1]!.length;
      }
      continue;
    }
    if (rawLead < curIndent) {
      const m = /^(\s*)("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:/.exec(code);
      if (m) {
        const key = (m[3] ?? m[4] ?? m[5])!;
        path.unshift(key);
        if (parentLine < 0) parentLine = i;
        curIndent = rawLead;
        if (curIndent === 0) break;
      }
    }
  }
  return { path, parentLine };
}

function collectSiblingKeys(
  lines: readonly string[],
  lineIndex: number,
  parentLine: number,
  keyIndent: number,
): Set<string> {
  const siblings = new Set<string>();
  const parentIndent = parentLine >= 0 ? lines[parentLine]!.length - lines[parentLine]!.trimStart().length : -1;
  const start = parentLine >= 0 ? parentLine + 1 : 0;
  for (let i = start; i < lines.length; i++) {
    if (i === lineIndex) continue;
    const { code } = stripInlineComment(lines[i]!.replace(/\r$/, ""));
    if (!code.trim()) continue;
    const lead = code.length - code.trimStart().length;
    if (parentIndent >= 0 && lead <= parentIndent) break;
    if (lead === keyIndent) {
      const m = /^(\s*)("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:/.exec(code);
      if (m) siblings.add((m[3] ?? m[4] ?? m[5])!);
    }
  }
  return siblings;
}

function applyText(insertText: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    view.dispatch({
      ...insertCompletionText(view.state, insertText, from, to),
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
    });
  };
}

/**
 * Completes internal Compose references (`depends_on`, `links`, `volumes_from`, `extends.service`,
 * `networks`, `volumes`, `configs`, `secrets`); schema keys and values come from `yaml-language-server`.
 */
export function composeCompletionsAt(text: string, pos: number, explicit: boolean): CompletionResult | null {
  const lines = text.split("\n");
  let offset = 0;
  let lineIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = offset + lines[i]!.length + 1;
    if (pos < next || i === lines.length - 1) {
      lineIndex = i;
      break;
    }
    offset = next;
  }
  const rawLine = lines[lineIndex]!.replace(/\r$/, "");
  const col = Math.max(0, Math.min(rawLine.length, pos - offset));
  const { code, commentStart } = stripInlineComment(rawLine);
  if (commentStart !== null && col > commentStart) return null;

  const before = code.slice(0, col);
  const after = code.slice(col);
  const model = parseComposeDocument(text);

  // 1. Value after `key: <value>` (e.g. `extends.service: <svc>`, `volumes[].source: <vol>`)
  const valMatch = /^(\s*)(?:-\s+)?("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:\s*([A-Za-z0-9._-]*)$/.exec(before);
  if (valMatch) {
    const leadSpaces = valMatch[1]!;
    const isListKey = /^\s*-\s+/.test(before);
    const keyIndent = isListKey ? leadSpaces.length + 2 : leadSpaces.length;
    const key = (valMatch[3] ?? valMatch[4] ?? valMatch[5])!;
    const prefix = valMatch[6]!;
    if (!explicit && !prefix) return null;
    const from = pos - prefix.length;
    const endMatch = /^[A-Za-z0-9._-]*/.exec(after);
    const to = pos + (endMatch?.[0].length ?? 0);
    const { path } = ancestorPathAt(lines, lineIndex, keyIndent);

    if (path.length === 3 && path[0] === "services") {
      const currentService = path[1]!;
      const section = path[2];
      if (section === "extends" && key === "service") {
        const services = [...model.services.keys()].filter((s) => s !== currentService);
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: services.map((s) => ({
            label: s,
            type: "constant",
            icon: "file-docker",
            typeText: "service",
            apply: applyText(s),
          })),
        };
      }
      if ((section === "volumes" || section === "configs" || section === "secrets") && key === "source") {
        const names = [...model[section].keys()];
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: names.map((n) => ({
            label: n,
            type: "constant",
            icon: section === "volumes" ? "docker-volumes" : undefined,
            typeText: section.slice(0, -1),
            apply: applyText(n),
          })),
        };
      }
    }
    return null;
  }

  // 2. Sequence item `- <ref>` under `depends_on`, `links`, `volumes_from`, `networks`, `volumes`, `configs`, `secrets`
  const listMatch = /^(\s*)-\s+([A-Za-z0-9._-]*)$/.exec(before);
  if (listMatch) {
    const dashIndent = listMatch[1]!.length;
    const prefix = listMatch[2]!;
    if (!explicit && !prefix) return null;
    const from = pos - prefix.length;
    const endMatch = /^[A-Za-z0-9._-]*/.exec(after);
    const to = pos + (endMatch?.[0].length ?? 0);
    const { path } = ancestorPathAt(lines, lineIndex, dashIndent + 1);
    if (path.length === 3 && path[0] === "services") {
      const currentService = path[1]!;
      const section = path[2];
      if (section === "depends_on" || section === "links" || section === "volumes_from") {
        const services = [...model.services.keys()].filter((s) => s !== currentService);
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: services.map((s) => ({
            label: s,
            type: "constant",
            icon: "file-docker",
            typeText: "service",
            apply: applyText(s),
          })),
        };
      }
      if (section === "networks") {
        const nets = [...new Set([...model.networks.keys(), "default"])];
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: nets.map((n) => ({
            label: n,
            type: "constant",
            icon: "docker-networks",
            typeText: "network",
            apply: applyText(n),
          })),
        };
      }
      if (section === "volumes") {
        const vols = [...model.volumes.keys()];
        if (!vols.length) return null;
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: vols.map((v) => ({
            label: v,
            type: "constant",
            icon: "docker-volumes",
            typeText: "volume",
            apply: applyText(after.startsWith(":") ? v : `${v}:`),
          })),
        };
      }
      if (section === "configs" || section === "secrets") {
        const names = [...model[section].keys()];
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: names.map((n) => ({
            label: n,
            type: "constant",
            typeText: section.slice(0, -1),
            apply: applyText(n),
          })),
        };
      }
    }
    return null;
  }

  // 3. Mapping key under `services.<svc>.depends_on` or `services.<svc>.networks`
  const keyMatch = /^(\s*)([A-Za-z0-9._-]*)$/.exec(before);
  if (keyMatch) {
    const indentStr = keyMatch[1]!;
    const prefix = keyMatch[2]!;
    if (!explicit && !prefix) return null;
    const keyIndent = indentStr.length;
    const from = pos - prefix.length;
    const endMatch = /^[A-Za-z0-9._-]*/.exec(after);
    const to = pos + (endMatch?.[0].length ?? 0);
    const hasColonAfter = /^\s*:/.test(after.slice(endMatch?.[0].length ?? 0));
    const { path, parentLine } = ancestorPathAt(lines, lineIndex, keyIndent);
    if (path.length === 3 && path[0] === "services") {
      const currentService = path[1]!;
      const section = path[2];
      const siblings = collectSiblingKeys(lines, lineIndex, parentLine, keyIndent);
      if (section === "depends_on") {
        const services = [...model.services.keys()].filter((s) => s !== currentService && !siblings.has(s));
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: services.map((s) => ({
            label: s,
            type: "property",
            icon: "file-docker",
            typeText: "service",
            apply: applyText(hasColonAfter ? s : `${s}:\n${indentStr}  condition: service_started`),
          })),
        };
      }
      if (section === "networks") {
        const nets = [...new Set([...model.networks.keys(), "default"])].filter((n) => !siblings.has(n));
        return {
          from,
          to,
          validFor: /^[A-Za-z0-9._-]*$/,
          options: nets.map((n) => ({
            label: n,
            type: "property",
            icon: "docker-networks",
            typeText: "network",
            apply: applyText(hasColonAfter ? n : `${n}:`),
          })),
        };
      }
    }
  }

  return null;
}

function wordBoundsAt(lineText: string, col: number): { word: string; startCol: number; endCol: number } | null {
  const isWord = (ch: string) => /[A-Za-z0-9._-]/.test(ch);
  let start = col;
  let end = col;
  while (start > 0 && isWord(lineText[start - 1]!)) start--;
  while (end < lineText.length && isWord(lineText[end]!)) end++;
  if (start >= end) return null;
  return { word: lineText.slice(start, end), startCol: start, endCol: end };
}

const modelCache = new WeakMap<EditorState["doc"], { text: string; model: ComposeDocumentModel }>();

function cachedComposeModel(doc: EditorState["doc"]): { text: string; model: ComposeDocumentModel } {
  const hit = modelCache.get(doc);
  if (hit) return hit;
  const text = doc.toString();
  const entry = { text, model: parseComposeDocument(text) };
  modelCache.set(doc, entry);
  return entry;
}

/** Resolves a service, network, volume, config or secret reference at `pos` to its declaration. */
export function resolveComposeReferenceAt(state: EditorState, pos: number): ComposeDeclaration | null {
  const clamped = Math.max(0, Math.min(pos, state.doc.length));
  const line = state.doc.lineAt(clamped);
  const { code, commentStart } = stripInlineComment(line.text);
  const col = clamped - line.from;
  if (commentStart !== null && col > commentStart) return null;
  const wordInfo = wordBoundsAt(code, col);
  if (!wordInfo) return null;

  const { text, model } = cachedComposeModel(state.doc);
  const lines = text.split("\n");
  const lineIndex = line.number - 1;
  const isListKey = /^\s*-\s+[A-Za-z0-9._-]+\s*:/.test(code);
  const isListItem = /^\s*-\s+/.test(code);
  const rawLead = code.length - code.trimStart().length;
  const lead = isListKey ? rawLead + 2 : isListItem ? rawLead + 1 : rawLead;
  const { path } = ancestorPathAt(lines, lineIndex, lead);

  if (path.length === 3 && path[0] === "services") {
    const section = path[2];
    if (section === "depends_on" || section === "links" || section === "volumes_from") {
      return model.services.get(wordInfo.word) ?? null;
    }
    if (section === "networks") {
      return model.networks.get(wordInfo.word) ?? null;
    }
    if (section === "volumes") {
      return model.volumes.get(wordInfo.word) ?? null;
    }
    if (section === "configs") {
      return model.configs.get(wordInfo.word) ?? null;
    }
    if (section === "secrets") {
      return model.secrets.get(wordInfo.word) ?? null;
    }
    if (section === "extends") {
      const m = /^\s*service\s*:\s*([A-Za-z0-9._-]+)/.exec(code);
      if (m?.[1] === wordInfo.word) return model.services.get(wordInfo.word) ?? null;
    }
  }
  return null;
}

function composeCompletion(path: string): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const { text } = cachedComposeModel(ctx.state.doc);
    if (!isComposeFile(path, text)) return null;
    return composeCompletionsAt(text, ctx.pos, ctx.explicit);
  };
}

export function composeEditorExtension(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  if (ctx.virtual || !isYamlFile(path)) return [];
  const completion = composeCompletion(path);
  return EditorState.languageData.of((state, pos) => {
    const { text } = cachedComposeModel(state.doc);
    if (!isComposeFile(path, text)) return [];
    const refTarget = resolveComposeReferenceAt(state, pos);
    return [
      {
        openideaCompletion: completion,
        ...(refTarget
          ? {
              [CONTRIBUTED_DEFINITION]: ((view: EditorView) => {
                view.dispatch({
                  selection: { anchor: refTarget.from, head: refTarget.to },
                  scrollIntoView: true,
                });
                return true;
              }) satisfies ContributedDefinition,
            }
          : {}),
      },
    ];
  });
}
