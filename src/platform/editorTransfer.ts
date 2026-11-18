import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import type { EditorInput } from "@/workbench/contributions";
import { call, commands, isTauri, type EditorHandoffAction, type EditorHandoffState } from "./ipc";
import { auxiliaryWindow } from "./auxWindow";
import { tx } from "./i18n";

export interface EditorTransfer {
  id: string;
  source: string;
  project: string | null;
  tab: { input: EditorInput; pinned: boolean };
  document?: unknown;
  feature?: unknown;
  libraries: string[];
}

const HANDOFF_TIMEOUT = 30000;
const HANDOFF_POLL = 50;
const waitForHandoffPoll = () => new Promise<void>((resolve) => setTimeout(resolve, HANDOFF_POLL));
const movingInputs = new Map<string, Map<symbol, string[]>>();
const settled = new Set<() => void>();
let transferHolds = 0;

export function editorTransfersAllowed(): boolean {
  return transferHolds === 0;
}

/** Project/window close waits for handoffs and admits no new ones until its decision settles. */
export async function withEditorTransfersHeld<T>(work: () => Promise<T>): Promise<T> {
  transferHolds++;
  try {
    while (movingInputs.size) await new Promise<void>((resolve) => settled.add(resolve));
    return await work();
  } finally {
    transferHolds--;
  }
}
export function isDocumentTransferring(path: string): boolean {
  return [...movingInputs.values()].some((group) => [...group.values()].some((paths) => paths.includes(path)));
}
export function beginEditorTransfer(input: EditorInput): () => void {
  const token = Symbol();
  const group = movingInputs.get(input.key) ?? new Map<symbol, string[]>();
  movingInputs.set(input.key, group);
  group.set(token, input.path ? [input.path] : []);
  return () => {
    if (!group.delete(token)) return;
    if (!group.size && movingInputs.get(input.key) === group) movingInputs.delete(input.key);
    if (!movingInputs.size) {
      settled.forEach((resolve) => resolve());
      settled.clear();
    }
  };
}

/** Reject unsupported runtime objects instead of silently dropping session state. */
export function encodeEditorTransfer(transfer: EditorTransfer): string {
  return JSON.stringify(transfer, (_key, value: unknown) => {
    if (value instanceof Map) return { __editorTransferType: "map", entries: [...value] };
    if (value instanceof Set) return { __editorTransferType: "set", entries: [...value] };
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
      throw new Error(tx("This editor contains state that cannot be moved to another window"));
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new Error(tx("This editor contains state that cannot be moved to another window"));
    return value;
  });
}

export function decodeEditorTransfer(payload: string): EditorTransfer {
  return JSON.parse(payload, (_key, value) =>
    value?.__editorTransferType === "map"
      ? new Map(value.entries)
      : value?.__editorTransferType === "set"
        ? new Set(value.entries)
        : value,
  ) as EditorTransfer;
}

export async function updateEditorHandoff(
  id: string,
  action: EditorHandoffAction,
  signal?: AbortSignal,
  deadline = performance.now() + HANDOFF_TIMEOUT,
): Promise<EditorHandoffState> {
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    try {
      return await call(commands.windowEditorHandoff(id, action));
    } catch {
      await waitForHandoffPoll();
    }
  }
  throw new Error(tx("The editor window did not respond"));
}

/** Either window can recover the result from native state after a missed reply. */
export async function waitForEditorHandoff(
  id: string,
  expected: "ready" | "finished",
  signal?: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + HANDOFF_TIMEOUT;
  while (performance.now() < deadline) {
    const state = await updateEditorHandoff(id, "status", signal, deadline);
    if (state === expected) return;
    if (state === "cancelled") break;
    await waitForHandoffPoll();
  }
  throw new Error(tx("The editor window did not respond"));
}

/** The source keeps its tab until native state records the handoff. */
export async function prepareEditorWindow(
  transfer: EditorTransfer,
  position: { x: number; y: number } | null,
): Promise<{ commit(): Promise<void>; finish(): Promise<void>; rollback(): Promise<void> }> {
  const payload = encodeEditorTransfer(transfer);
  let target: string | undefined;
  const rollback = async () => {
    const state = await updateEditorHandoff(transfer.id, "cancel");
    if (state === "committed" || state === "finished" || !target) return;
    const window = await Window.getByLabel(target);
    await window?.close();
  };
  try {
    const result = await call(
      commands.windowDetachEditor({ id: transfer.id, source: transfer.source, payload }, position),
    );
    if (result.kind !== "opened") throw new Error(tx("The editor window did not respond"));
    target = result.label;
    await waitForEditorHandoff(transfer.id, "ready");
    return {
      async commit() {
        // A cancellation after an unknown reply returns the recorded commit if it won.
        const state = await updateEditorHandoff(transfer.id, "commit").catch(() =>
          updateEditorHandoff(transfer.id, "cancel"),
        );
        if (state !== "committed" && state !== "finished") throw new Error(tx("The editor window did not respond"));
      },
      async finish() {
        if ((await updateEditorHandoff(transfer.id, "finish")) !== "finished")
          throw new Error(tx("The editor window did not respond"));
      },
      rollback,
    };
  } catch (error) {
    await rollback().catch(() => {});
    throw error;
  }
}

export async function hasEditorWindows(): Promise<boolean> {
  if (!isTauri()) return false;
  const { getAllWindows } = await import("@tauri-apps/api/window");
  const parent = getCurrentWindow().label;
  return (await getAllWindows()).some(({ label }) => {
    const aux = auxiliaryWindow(label);
    return aux?.kind === "editor" && aux.parent === parent;
  });
}
