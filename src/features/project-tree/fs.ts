/**
 * File system access for the project view. Uses the backend in the desktop
 * app; plain-browser development (and tests) use an in-memory file system.
 */
import type { FileEntry } from "@/bindings";
import { notifyFileOperation } from "@/platform/fileOps";
import { call, commands, emitLocalIdeEvent, isTauri, IpcError, nextRequestId } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { invokeLocal } from "@/platform/tauriCore";
import { tx } from "@/platform/i18n";
import { upsertTask } from "@/workbench/tasks";
import { isInside, joinPath, nameOf, parentOf } from "./paths";

export interface ProjectFs {
  readDir(path: string): Promise<FileEntry[]>;
  createFile(path: string): Promise<void>;
  /** Creates `path` with `data`; fails when it exists. */
  createFileBytes(path: string, data: Uint8Array): Promise<void>;
  createDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Moves to the trash when possible. */
  delete(path: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  importLocal(from: string, to: string, upload?: LocalImport): Promise<string[]>;
}

export const tauriFs: ProjectFs = {
  readDir: (path) => call(commands.fsReadDir(path)),
  createFile: async (path) => {
    await call(commands.fsCreateFile(path));
    notifyFileOperation({ kind: "created", paths: [path] });
  },
  createFileBytes: async (path, data) => {
    await call(commands.fsCreateFileBytes(path, [...data]));
    notifyFileOperation({ kind: "created", paths: [path] });
  },
  createDir: async (path) => void (await call(commands.fsCreateDir(path))),
  rename: async (from, to) => void (await call(commands.fsRename(from, to))),
  delete: async (path) => {
    await call(commands.fsDelete(path));
    notifyFileOperation({ kind: "deleted", paths: [path] });
  },
  copy: async (from, to) => {
    await call(commands.fsCopy(from, to));
    notifyFileOperation({ kind: "created", paths: [to] });
  },
  importLocal: async (from, to, upload) => {
    if (!isRemoteWindow()) {
      await tauriFs.copy(from, to);
      return [];
    }
    const batch = upload ?? beginLocalImport();
    try {
      const request = batch.start(from);
      const skipped = await call(commands.remoteImportLocal(from, to, request));
      notifyFileOperation({ kind: "created", paths: [to] });
      return skipped;
    } finally {
      if (!upload) batch.finish();
    }
  },
};

interface LocalImport {
  readonly cancelled: boolean;
  start(from: string): number;
  finish(): void;
}

/** One task spans every selected path; cancellation also stops paths not started yet. */
export function beginLocalImport(): LocalImport {
  let cancelled = false;
  let request = nextRequestId();
  const task = {
    id: `file-import-${request}`,
    title: tx("Uploading files"),
    message: null as string | null,
    fraction: null,
    cancel: () => {
      cancelled = true;
      void invokeLocal("cancel_request", { id: request }).catch(() => {});
    },
  };
  upsertTask({ ...task, done: false });
  return {
    get cancelled() {
      return cancelled;
    },
    start(from) {
      if (cancelled) throw new IpcError({ kind: "cancelled", message: "Cancelled" });
      request = nextRequestId();
      task.message = nameOf(from);
      upsertTask({ ...task, done: false });
      return request;
    },
    finish() {
      upsertTask({ ...task, done: true });
    },
  };
}

type MemNode = { kind: "file"; size: number } | { kind: "dir" } | { kind: "symlink"; target: string };

/** What a link resolves to (the loop in `resolve` never stops on a link). */
type ResolvedNode = Exclude<MemNode, { kind: "symlink" }>;

const err = (kind: "notFound" | "alreadyExists" | "invalidInput", message: string) => new IpcError({ kind, message });

/** The tree's own notion (see `isDirEntry`): a folder, or a link to one. */
const isFolder = (e: FileEntry) => e.kind === "dir" || (e.kind === "symlink" && e.size === 0);

/** Minimal in-memory file system with the backend's semantics (no overwrite, folders first). */
export class MemoryFs implements ProjectFs {
  readonly nodes = new Map<string, MemNode>();
  ignored = new Set<string>();
  /** Called after every mutation with the changed paths (simulates the watcher). */
  onChange?: (e: { created: string[]; modified: string[]; removed: string[] }) => void;

  constructor(files: Record<string, string | null> = {}, root = "/", links: Record<string, string> = {}) {
    this.nodes.set(root, { kind: "dir" });
    for (const [path, content] of Object.entries(files)) {
      if (content === null) this.mkdirp(path);
      else {
        this.mkdirp(parentOf(path));
        this.nodes.set(path, { kind: "file", size: content.length });
      }
    }
    for (const [path, target] of Object.entries(links)) {
      this.mkdirp(parentOf(path));
      this.nodes.set(path, { kind: "symlink", target });
    }
  }

  private mkdirp(path: string) {
    for (let p = path; p && !this.nodes.has(p); p = parentOf(p)) {
      this.nodes.set(p, { kind: "dir" });
      if (p === "/") break;
    }
  }

  private childrenOf(dir: string) {
    return [...this.nodes.keys()].filter((p) => p !== dir && parentOf(p) === dir);
  }

  /** Follows symlinks (bounded, so a link cycle errors instead of hanging). */
  private resolve(path: string): { path: string; node: ResolvedNode | undefined } {
    let p = path;
    let n = this.nodes.get(p);
    for (let hops = 0; n?.kind === "symlink"; hops++) {
      if (hops > 16) throw err("invalidInput", `${path} is a symlink loop`);
      p = n.target;
      n = this.nodes.get(p);
    }
    // The loop only exits on a non-link entry (or a missing one).
    return { path: p, node: n as ResolvedNode | undefined };
  }

  async readDir(at: string): Promise<FileEntry[]> {
    // Like the backend, listing a symlink to a folder lists through the link.
    const { path, node } = this.resolve(at);
    if (!node) throw err("notFound", `${path} not found`);
    if (node.kind !== "dir") throw err("invalidInput", `${at} is not a directory`);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    return (
      this.childrenOf(path)
        .map((p) => {
          const c = this.nodes.get(p)!;
          const name = nameOf(p);
          const excluded = [...this.ignored].some((i) => p === i || isInside(p, i));
          if (c.kind === "symlink") {
            const t = this.resolve(p);
            return {
              name,
              path: p,
              kind: "symlink",
              // A link to a folder has size 0; a dangling one the link's own length (the backend's `symlink_metadata`).
              size: t.node ? (t.node.kind === "dir" ? 0 : t.node.size) : c.target.length,
              ...(t.node && { targetKind: t.node.kind === "dir" ? "dir" : "file" }),
              mtimeMs: 0,
              ignored: excluded,
              excluded,
              hidden: name.startsWith("."),
            } satisfies FileEntry;
          }
          return {
            name,
            path: p,
            kind: c.kind,
            size: c.kind === "file" ? c.size : 0,
            mtimeMs: 0,
            ignored: excluded,
            excluded,
            hidden: name.startsWith("."),
          } satisfies FileEntry;
        })
        // Folders first, counting a link to a folder as a folder (the backend's ordering).
        .sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || collator.compare(a.name, b.name))
    );
  }

  private emit(e: Partial<{ created: string[]; modified: string[]; removed: string[] }>) {
    this.onChange?.({ created: e.created ?? [], modified: e.modified ?? [], removed: e.removed ?? [] });
  }

  async createFile(path: string) {
    if (this.nodes.has(path)) throw err("alreadyExists", `${path} already exists`);
    this.mkdirp(parentOf(path));
    this.nodes.set(path, { kind: "file", size: 0 });
    this.emit({ created: [path] });
  }

  async createFileBytes(path: string, data: Uint8Array) {
    if (this.nodes.has(path)) throw err("alreadyExists", `${path} already exists`);
    this.mkdirp(parentOf(path));
    this.nodes.set(path, { kind: "file", size: data.length });
    this.emit({ created: [path] });
  }

  async createDir(path: string) {
    if (this.nodes.has(path)) throw err("alreadyExists", `${path} already exists`);
    this.mkdirp(path);
    this.emit({ created: [path] });
  }

  async rename(from: string, to: string) {
    if (!this.nodes.has(from)) throw err("notFound", `${from} not found`);
    if (this.nodes.has(to) && from.toLowerCase() !== to.toLowerCase())
      throw err("alreadyExists", `${to} already exists`);
    if (isInside(to, from)) throw err("invalidInput", "cannot move a folder into itself");
    for (const p of [...this.nodes.keys()]) {
      if (p !== from && !isInside(p, from)) continue;
      const n = this.nodes.get(p)!;
      this.nodes.delete(p);
      this.nodes.set(to + p.slice(from.length), n);
    }
    this.emit({ created: [to], removed: [from] });
  }

  async delete(path: string) {
    if (!this.nodes.has(path)) throw err("notFound", `${path} not found`);
    for (const p of [...this.nodes.keys()]) if (p === path || isInside(p, path)) this.nodes.delete(p);
    this.emit({ removed: [path] });
  }

  async copy(from: string, to: string) {
    if (!this.nodes.has(from)) throw err("notFound", `${from} not found`);
    if (this.nodes.has(to)) throw err("alreadyExists", `${to} already exists`);
    for (const p of [...this.nodes.keys()]) {
      if (p !== from && !isInside(p, from)) continue;
      this.nodes.set(to + p.slice(from.length), { ...this.nodes.get(p)! });
    }
    this.emit({ created: [to] });
  }

  async importLocal(from: string, to: string): Promise<string[]> {
    await this.copy(from, to);
    return [];
  }
}

/** Sample project for plain-browser development (matches the design mock). */
export function sampleFs(root: string): MemoryFs {
  const f = (rel: string, content: string | null = "") => [joinPath(root, rel), content] as const;
  const fs = new MemoryFs(
    Object.fromEntries([
      f("src/main/kotlin/com/acme/orders/model/Order.kt"),
      f("src/main/kotlin/com/acme/orders/model/OrderStatus.kt"),
      f("src/main/kotlin/com/acme/orders/service/OrderService.kt"),
      f("src/main/kotlin/com/acme/orders/OrderController.kt"),
      f("src/main/kotlin/com/acme/orders/OrderDto.kt"),
      f("src/main/kotlin/com/acme/orders/PageRequest.kt"),
      f("src/main/kotlin/com/acme/orders/OrderApplication.kt"),
      f("src/main/resources/application.yml"),
      f("src/main/resources/logo.png"),
      f("src/test/kotlin/com/acme/orders/OrderControllerTest.kt"),
      f("build", null),
      f("build/classes/Main.class"),
      f(".git/HEAD"),
      f(".gitignore"),
      f("build.gradle.kts"),
      f("settings.gradle.kts"),
      f("README.md"),
      f(
        "App.tsx",
        `export function App() {
  return (
    <div>
      <b>x</b>
    </div>
  );
}
`,
      ),
      ...Array.from({ length: 10_000 }, (_, i) => f(`generated/item${i + 1}.json`)),
    ]),
    root,
  );
  fs.ignored.add(joinPath(root, "build"));
  fs.ignored.add(joinPath(root, "generated"));
  return fs;
}

let current: ProjectFs = tauriFs;
let sampleRoot: string | null = null;

/** The file system for `root` (the backend, or a sample in plain-browser mode). */
export function projectFs(root: string): ProjectFs {
  if (isTauri()) return tauriFs;
  if (sampleRoot !== root) {
    sampleRoot = root;
    const fs = sampleFs(root);
    fs.onChange = (e) => queueMicrotask(() => emitLocalIdeEvent({ type: "fsChanged", ...e }));
    current = fs;
  }
  return current;
}

/** Tests: force a file system implementation. */
export function setProjectFsForTests(fs: ProjectFs | null, root: string | null = null) {
  current = fs ?? tauriFs;
  sampleRoot = fs ? root : null;
}
