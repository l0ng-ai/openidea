/**
 * Attach to Process (⌥⇧F5): the popup model (filter + groups by debugger) and the
 * attach request each debugger needs, like IDEA's `XAttachDebuggerProvider`s.
 */
import { workflowSettings } from "@/platform/workflowSettings";
import type { AttachKind, AttachableProcess, LaunchConfig } from "@/platform/ipc";
import { javaAttachConfig } from "./java";

export const KIND_LABELS: Record<AttachKind, string> = {
  unity: "Unity Editor",
  java: "Java (JDWP)",
  node: "Node.js",
  python: "Python (debugpy)",
  go: "Go (Delve)",
  native: "Native (LLDB)",
};

const KIND_ORDER: AttachKind[] = ["unity", "java", "node", "python", "go", "native"];

export type AttachRow =
  | { kind: "group"; key: string; label: string; count: number }
  | { kind: "process"; key: string; process: AttachableProcess };

/** Case-insensitive match on pid, name and command line; every word must match. */
export function matchesFilter(p: AttachableProcess, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${p.pid} ${p.name} ${p.commandLine}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Rows of the popup: a header per debugger, then its processes (interpreters first). */
export function attachRows(list: readonly AttachableProcess[], filter: string): AttachRow[] {
  const rows: AttachRow[] = [];
  for (const kind of KIND_ORDER) {
    const items = list.filter((p) => p.kind === kind && matchesFilter(p, filter));
    if (!items.length) continue;
    rows.push({ kind: "group", key: `group:${kind}`, label: KIND_LABELS[kind], count: items.length });
    for (const p of items) rows.push({ kind: "process", key: `${kind}:${p.pid}`, process: p });
  }
  return rows;
}

/** A short description of how the process will be attached to. */
export function attachDetail(p: AttachableProcess): string {
  if (p.port != null) return `${p.host ?? "localhost"}:${p.port}`;
  return `pid ${p.pid}`;
}

function base(p: AttachableProcess, cwd: string, extra: Record<string, unknown>): LaunchConfig {
  return {
    name: `${p.name} (${p.pid})`,
    adapter: p.adapter,
    request: "attach",
    program: null,
    args: [],
    cwd,
    env: {},
    extraJson: JSON.stringify(extra),
  };
}

/** The attach request for `p`; `root` is the project root (sources, java module). */
export async function attachConfig(p: AttachableProcess, root: string): Promise<LaunchConfig> {
  const skip = workflowSettings().debugger.skipLibraryCode;
  switch (p.kind) {
    case "unity":
      return {
        ...base(p, root, {
          name: `Unity Editor (${p.pid})`,
          path: `${root}/Library/EditorInstance.json`,
          __exceptionOptions: [],
        }),
        adapter: "unity",
      };
    case "java":
      return javaAttachConfig(
        { name: `${p.name} (${p.pid})`, module: "", hostName: p.host ?? "localhost", port: p.port! },
        root,
      );
    case "node":
      return base(p, root, {
        type: "pwa-node",
        ...(p.port != null ? { address: p.host ?? "localhost", port: p.port } : { processId: String(p.pid) }),
        skipFiles: skip ? ["<node_internals>/**", "**/node_modules/**"] : [],
        // Without `--inspect`, js-debug enables the inspector by signalling the process.
        continueOnAttach: true,
      });
    case "python":
      return base(
        p,
        root,
        // `debugpy --listen` runs its own adapter on that port: talk DAP to it directly.
        // (`--pid` injection ships only an x86_64 helper on macOS.)
        p.port != null ? { debugServer: p.port, justMyCode: skip } : { processId: p.pid, justMyCode: skip },
      );
    case "go":
      return base(p, root, { mode: "local", processId: p.pid });
    case "native":
      return base(p, root, { pid: p.pid });
  }
}
