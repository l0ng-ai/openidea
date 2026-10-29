/**
 * The document backend as seen by editor/core. Production uses the Tauri IPC
 * commands; tests and the plain-browser dev shell use the in-memory
 * implementation, which follows the same versioning contract (every applied
 * change set bumps the version by one; stale base versions are rejected with
 * `outOfSync`).
 */
import {
  call,
  commands,
  IpcError,
  isTauri,
  onIdeEvent,
  type DocId,
  type DocumentInfo,
  type FoldRange,
  type LanguageInfo_Serialize,
  type LineEnding,
  type OutlineItem,
  type Range,
  type SyntaxHighlights,
  type TextChange,
} from "@/platform/ipc";

export type LanguageInfo = LanguageInfo_Serialize;

export interface DocPatchedEvent {
  doc: DocId;
  baseVersion: number;
  version: number;
  changes: TextChange[];
}

export interface DocBackend {
  open(path: string): Promise<DocumentInfo>;
  /** Opens the read-only virtual document behind a non-`file:` URI (library class contents). */
  openVirtual(uri: string): Promise<DocumentInfo>;
  close(doc: DocId): Promise<void>;
  edit(doc: DocId, baseVersion: number, changes: TextChange[]): Promise<number>;
  save(doc: DocId): Promise<void>;
  snapshot(doc: DocId): Promise<DocumentInfo>;
  setLineEnding(doc: DocId, lineEnding: LineEnding): Promise<void>;
  /** "Reload with Encoding" (`reload`) or "Convert to Encoding"; resolves to the new encoding. */
  setEncoding(doc: DocId, encoding: string, reload: boolean): Promise<string>;
  outline(doc: DocId): Promise<OutlineItem[]>;
  folding(doc: DocId): Promise<FoldRange[]>;
  /** Tree-sitter highlighting, for languages without a CodeMirror mode. */
  highlights(doc: DocId): Promise<SyntaxHighlights>;
  selectionRanges(doc: DocId, offset: number): Promise<Range[]>;
  languages(): Promise<LanguageInfo[]>;
  onPatched(handler: (e: DocPatchedEvent) => void): () => void;
  onDirty(handler: (e: { doc: DocId; dirty: boolean }) => void): () => void;
  /** Files changed on disk (used to refresh nothing but closed-file state). */
  onFsChanged?(handler: (e: { removed: string[] }) => void): () => void;
  /** An open document's language changed (Settings › File Types, Override File Type). */
  onLanguage?(handler: (e: { doc: DocId; language: string }) => void): () => void;
}

export const ipcBackend: DocBackend = {
  open: (path) => call(commands.docOpen(path)),
  openVirtual: (uri) => call(commands.docOpenVirtual(uri)),
  close: async (doc) => void (await call(commands.docClose(doc))),
  edit: (doc, baseVersion, changes) => call(commands.docEdit(doc, baseVersion, { changes })),
  save: async (doc) => void (await call(commands.docSave(doc))),
  snapshot: (doc) => call(commands.docSnapshot(doc)),
  setLineEnding: async (doc, le) => void (await call(commands.docSetLineEnding(doc, le))),
  setEncoding: (doc, encoding, reload) => call(commands.docSetEncoding(doc, encoding, reload)),
  outline: (doc) => call(commands.docOutline(doc)),
  folding: (doc) => call(commands.docFolding(doc)),
  highlights: (doc) => call(commands.docHighlights(doc)),
  selectionRanges: (doc, offset) => call(commands.docSelectionRanges(doc, offset)),
  languages: () => commands.languages(),
  onPatched: (h) => onIdeEvent("docPatched", (e) => h(e)),
  onDirty: (h) => onIdeEvent("docDirty", (e) => h(e)),
  onFsChanged: (h) => onIdeEvent("fsChanged", (e) => h(e)),
  onLanguage: (h) => onIdeEvent("docLanguage", (e) => h(e)),
};

// ---------------------------------------------------------------------------
// In-memory backend

interface MemDoc {
  id: DocId;
  path: string;
  text: string;
  saved: string;
  version: number;
  refs: number;
  lineEnding: LineEnding;
  readOnly: boolean;
  language: string;
  uri?: string;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  py: "python",
  gd: "gdscript",
  go: "go",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  c: "c",
  cpp: "cpp",
  h: "c",
  sh: "shellscript",
  bat: "bat",
  cmd: "bat",
  sql: "sql",
  xml: "xml",
};

const MEM_LANGUAGES: LanguageInfo[] = [
  {
    id: "typescript",
    name: "TypeScript",
    extensions: ["ts"],
    uiMode: "TypeScript",
    lineComment: "//",
    blockComment: ["/*", "*/"],
    indent: { tabSize: 2, insertSpaces: true },
  },
  {
    id: "typescriptreact",
    name: "TypeScript JSX",
    extensions: ["tsx"],
    uiMode: "TSX",
    lineComment: "//",
    blockComment: ["/*", "*/"],
    indent: { tabSize: 2, insertSpaces: true },
  },
  {
    id: "javascript",
    name: "JavaScript",
    extensions: ["js"],
    uiMode: "JavaScript",
    lineComment: "//",
    blockComment: ["/*", "*/"],
    indent: { tabSize: 2, insertSpaces: true },
  },
  {
    id: "rust",
    name: "Rust",
    extensions: ["rs"],
    uiMode: "Rust",
    lineComment: "//",
    blockComment: ["/*", "*/"],
    indent: null,
  },
  {
    id: "kotlin",
    name: "Kotlin",
    extensions: ["kt", "kts"],
    uiMode: "Kotlin",
    lineComment: "//",
    blockComment: ["/*", "*/"],
    indent: null,
  },
  {
    id: "java",
    name: "Java",
    extensions: ["java"],
    uiMode: "Java",
    lineComment: "//",
    blockComment: ["/*", "*/"],
    indent: null,
  },
  {
    id: "python",
    name: "Python",
    extensions: ["py"],
    uiMode: "Python",
    lineComment: "#",
    blockComment: null,
    indent: null,
  },
  {
    id: "gdscript",
    name: "GDScript",
    extensions: ["gd"],
    uiMode: null,
    lineComment: "#",
    blockComment: null,
    indent: { tabSize: 4, insertSpaces: false },
  },
  {
    id: "json",
    name: "JSON",
    extensions: ["json"],
    uiMode: "JSON",
    lineComment: null,
    blockComment: null,
    indent: { tabSize: 2, insertSpaces: true },
  },
  {
    id: "markdown",
    name: "Markdown",
    extensions: ["md"],
    uiMode: "Markdown",
    lineComment: null,
    blockComment: ["<!--", "-->"],
    indent: null,
  },
  {
    id: "yaml",
    name: "YAML",
    extensions: ["yml", "yaml"],
    uiMode: "YAML",
    lineComment: "#",
    blockComment: null,
    indent: { tabSize: 2, insertSpaces: true },
  },
  {
    id: "bat",
    name: "Batch",
    extensions: ["bat", "cmd"],
    uiMode: "Batch",
    lineComment: "@REM",
    blockComment: null,
    indent: { tabSize: 4, insertSpaces: true },
  },
  {
    id: "plaintext",
    name: "Plain Text",
    extensions: ["txt"],
    uiMode: null,
    lineComment: null,
    blockComment: null,
    indent: null,
  },
];

const SAMPLE_KOTLIN = `package com.acme.orders

import org.springframework.web.bind.annotation.*
import com.acme.orders.service.OrderService

@RestController
@RequestMapping("/api/orders")
class OrderController(private val service: OrderService) {

    // Paged order lookup, optionally filtered by status
    @GetMapping
    fun list(
        @RequestParam status: OrderStatus?,
        @RequestParam page: Int = 0,
        @RequestParam size: Int = 20
    ): Page<OrderDto> =
        service.find(status, PageRequest(page, size)).map { it.toDto() }

    @PostMapping
    fun create(@RequestBody req: CreateOrderRequest): OrderDto {
        val order: Order = service.create(req)
        return order.toDto()
    }
}
`;

function applyChanges(text: string, changes: TextChange[]): string {
  let out = "";
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

function sampleFor(path: string): string {
  if (/\.kts?$/.test(path)) return SAMPLE_KOTLIN;
  return `// ${path}\n`;
}

/** Offset → 0-based line/col, using a precomputed table of line starts. */
function lineIndex(text: string) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: offset - starts[lo]! };
  };
}

export interface MemoryBackend extends DocBackend {
  /** Test/dev hook: apply a backend-originated change and emit `docPatched`. */
  patch(doc: DocId, changes: TextChange[]): void;
  /** Seed file contents before opening. */
  files: Map<string, string>;
  docs: Map<DocId, MemDoc>;
  /** Simulated latency for `edit` (ms); 0 resolves in a microtask. */
  latency: number;
}

export function createMemoryBackend(files: Record<string, string> = {}): MemoryBackend {
  const docs = new Map<DocId, MemDoc>();
  const byPath = new Map<string, DocId>();
  const patched = new Set<(e: DocPatchedEvent) => void>();
  const dirtyHandlers = new Set<(e: { doc: DocId; dirty: boolean }) => void>();
  let nextId = 1;
  const store = new Map(Object.entries(files));

  const info = (d: MemDoc): DocumentInfo => ({
    id: d.id,
    path: d.path,
    text: d.text,
    version: d.version,
    language: d.language,
    encoding: "UTF-8",
    lineEnding: d.lineEnding,
    readOnly: d.readOnly,
    dirty: d.text !== d.saved,
    ...(d.uri ? { uri: d.uri } : {}),
  });
  const get = (doc: DocId) => {
    const d = docs.get(doc);
    if (!d) throw new IpcError({ kind: "notFound", message: `document ${doc} is not open` });
    return d;
  };
  const setDirty = (d: MemDoc, before: boolean) => {
    const now = d.text !== d.saved;
    if (now !== before) dirtyHandlers.forEach((h) => h({ doc: d.id, dirty: now }));
  };
  const delay = <T>(v: () => T): Promise<T> =>
    backend.latency > 0
      ? new Promise((resolve, reject) =>
          setTimeout(() => {
            try {
              resolve(v());
            } catch (e) {
              reject(e);
            }
          }, backend.latency),
        )
      : Promise.resolve().then(v);

  const backend: MemoryBackend = {
    files: store,
    docs,
    latency: 0,
    async open(path) {
      const existing = byPath.get(path);
      if (existing !== undefined) {
        const d = get(existing);
        d.refs++;
        return info(d);
      }
      const text = store.get(path) ?? sampleFor(path);
      const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      const d: MemDoc = {
        id: nextId++,
        path,
        text,
        saved: text,
        version: 0,
        refs: 1,
        lineEnding: "lf",
        readOnly: false,
        language: EXT_LANG[ext] ?? "plaintext",
      };
      docs.set(d.id, d);
      byPath.set(path, d.id);
      return info(d);
    },
    async openVirtual(uri) {
      const existing = byPath.get(uri);
      if (existing !== undefined) {
        const d = get(existing);
        d.refs++;
        return info(d);
      }
      const text = store.get(uri);
      if (text === undefined) throw new IpcError({ kind: "notFound", message: `no contents for ${uri}` });
      const name = uri.split(/[?#]/)[0]!;
      const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const d: MemDoc = {
        id: nextId++,
        path: uri,
        text,
        saved: text,
        version: 0,
        refs: 1,
        lineEnding: "lf",
        readOnly: true,
        language: ext === "class" ? "java" : (EXT_LANG[ext] ?? "plaintext"),
        uri,
      };
      docs.set(d.id, d);
      byPath.set(uri, d.id);
      return info(d);
    },
    async close(doc) {
      const d = docs.get(doc);
      if (!d || --d.refs > 0) return;
      docs.delete(doc);
      byPath.delete(d.path);
    },
    edit(doc, baseVersion, changes) {
      return delay(() => {
        const d = get(doc);
        if (d.readOnly) throw new IpcError({ kind: "permissionDenied", message: "read-only" });
        if (baseVersion !== d.version)
          throw new IpcError({ kind: "outOfSync", message: `base ${baseVersion}, document at ${d.version}` });
        const before = d.text !== d.saved;
        d.text = applyChanges(d.text, changes);
        d.version++;
        setDirty(d, before);
        return d.version;
      });
    },
    async save(doc) {
      const d = get(doc);
      const before = d.text !== d.saved;
      d.saved = d.text;
      store.set(d.path, d.text);
      setDirty(d, before);
    },
    async snapshot(doc) {
      return info(get(doc));
    },
    async setLineEnding(doc, le) {
      get(doc).lineEnding = le;
    },
    async setEncoding(_doc, encoding) {
      return encoding;
    },
    async outline(doc) {
      // Brace-based outline good enough for the dev shell.
      const d = get(doc);
      const posAt = (
        (index) => (_text: string, offset: number) =>
          index(offset)
      )(lineIndex(d.text));
      const items: OutlineItem[] = [];
      const re = /\b(class|fun|function|fn|interface|object)\s+([A-Za-z_]\w*)/g;
      for (let m = re.exec(d.text); m; m = re.exec(d.text)) {
        const start = posAt(d.text, m.index);
        const nameStart = posAt(d.text, m.index + m[0].length - m[2]!.length);
        const open = d.text.indexOf("{", m.index);
        let end = d.text.length;
        if (open >= 0) {
          let depth = 0;
          for (let i = open; i < d.text.length; i++) {
            if (d.text[i] === "{") depth++;
            else if (d.text[i] === "}" && --depth === 0) {
              end = i + 1;
              break;
            }
          }
        }
        const item: OutlineItem = {
          name: m[1] === "class" || m[1] === "interface" || m[1] === "object" ? m[2]! : `${m[2]}()`,
          detail: null,
          kind: m[1] === "class" ? "class" : m[1] === "interface" ? "interface" : "function",
          range: { start, end: posAt(d.text, end) },
          selection_range: { start: nameStart, end: { line: nameStart.line, col: nameStart.col + m[2]!.length } },
          children: [],
        };
        const parent = items.findLast(
          (p) =>
            (p.range.start.line < start.line ||
              (p.range.start.line === start.line && p.range.start.col <= start.col)) &&
            (p.range.end.line > start.line || (p.range.end.line === start.line && p.range.end.col >= start.col)),
        );
        if (parent) parent.children.push(item);
        else items.push(item);
      }
      return items;
    },
    async highlights() {
      return { kinds: [], data: [] };
    },
    async folding(doc) {
      const d = get(doc);
      const out: FoldRange[] = [];
      const seen = new Set<number>();
      const stack: number[] = [];
      d.text.split("\n").forEach((line, i) => {
        for (const ch of line) {
          if (ch === "{" || ch === "(" || ch === "[") stack.push(i);
          else if (ch === "}" || ch === ")" || ch === "]") {
            const s = stack.pop();
            if (s !== undefined && i > s && !seen.has(s)) {
              seen.add(s);
              out.push({ start_line: s, end_line: i, kind: "region" });
            }
          }
        }
      });
      return out.sort((a, b) => a.start_line - b.start_line);
    },
    async selectionRanges() {
      return [];
    },
    async languages() {
      return MEM_LANGUAGES;
    },
    onPatched(h) {
      patched.add(h);
      return () => patched.delete(h);
    },
    onDirty(h) {
      dirtyHandlers.add(h);
      return () => dirtyHandlers.delete(h);
    },
    patch(doc, changes) {
      const d = get(doc);
      const before = d.text !== d.saved;
      const baseVersion = d.version;
      d.text = applyChanges(d.text, changes);
      d.version++;
      const e = { doc, baseVersion, version: d.version, changes };
      patched.forEach((h) => h(e));
      setDirty(d, before);
    },
  };
  return backend;
}

let current: DocBackend | null = null;

/** The backend in use: IPC inside Tauri, in-memory in a plain browser. */
export function docBackend(): DocBackend {
  return (current ??= isTauri() ? ipcBackend : createMemoryBackend());
}
