/**
 * Method breakpoints (DAP function breakpoints) and field watchpoints (DAP data
 * breakpoints). Both are project-wide lists, persisted like line breakpoints and
 * mirrored to the backend, which sends them to every session whose adapter supports
 * them. Entries remember the source line they were created on for the gutter icon.
 */
import { create } from "zustand";
import { useProject } from "@/platform/project";
import { call, commands, isTauri, type DataBreakpoint, type FunctionBreakpoint } from "@/platform/ipc";
import { newBreakpointId, type BreakpointStatus } from "./model";
import { useBreakpoints } from "./store";

interface Common {
  id: string;
  /** Source location (gutter icon, Go to Source); null for watchpoints made from a value. */
  path: string | null;
  line: number | null;
  enabled: boolean;
  condition: string | null;
  hitCondition: string | null;
}

export interface MethodBreakpoint extends Common {
  kind: "method";
  /** Function name in the adapter's syntax (`pkg.Class#method`, `main.run`, `parse`). */
  name: string;
}

export type AccessType = "write" | "read" | "readWrite";

export interface FieldWatchpoint extends Common {
  kind: "field";
  dataId: string;
  /** What the user sees (`Order.total`). */
  label: string;
  accessType: AccessType | null;
}

export type SpecialBreakpoint = MethodBreakpoint | FieldWatchpoint;

interface SpecialState {
  root: string | null;
  methods: MethodBreakpoint[];
  fields: FieldWatchpoint[];
  status: Record<string, BreakpointStatus>;
}

export const useSpecialBreakpoints = create<SpecialState>(() => ({ root: null, methods: [], fields: [], status: {} }));

const STORAGE_PREFIX = "openidea.debugger.specialBreakpoints:";

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function common(raw: Record<string, unknown>): Common {
  return {
    id: str(raw.id) ?? newBreakpointId(),
    path: str(raw.path),
    line: Number.isInteger(raw.line) ? (raw.line as number) : null,
    enabled: raw.enabled !== false,
    condition: str(raw.condition),
    hitCondition: str(raw.hitCondition),
  };
}

export function sanitizeSpecial(raw: unknown): { methods: MethodBreakpoint[]; fields: FieldWatchpoint[] } {
  const data = (raw && typeof raw === "object" ? raw : {}) as { methods?: unknown; fields?: unknown };
  const records = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  const methods = records(data.methods)
    .filter((m) => typeof m.name === "string" && m.name.trim())
    .map((m): MethodBreakpoint => ({ ...common(m), kind: "method", name: m.name as string }));
  const fields = records(data.fields)
    .filter((f) => typeof f.dataId === "string" && f.dataId)
    .map((f): FieldWatchpoint => ({
      ...common(f),
      kind: "field",
      dataId: f.dataId as string,
      label: str(f.label) ?? (f.dataId as string),
      accessType:
        f.accessType === "read" || f.accessType === "readWrite" || f.accessType === "write" ? f.accessType : null,
    }));
  return { methods, fields };
}

function persist() {
  const { root, methods, fields } = useSpecialBreakpoints.getState();
  if (!root) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify({ methods, fields }));
  } catch {
    // Storage unavailable: kept for this session only.
  }
}

/** Backend lists; muting disables everything without touching the stored flags. */
export function toFunctionBreakpoints(list: readonly MethodBreakpoint[], muted: boolean): FunctionBreakpoint[] {
  return list.map((m) => ({
    name: m.name.trim(),
    condition: m.condition?.trim() || null,
    hitCondition: m.hitCondition?.trim() || null,
    enabled: m.enabled && !muted,
  }));
}

export function toDataBreakpoints(list: readonly FieldWatchpoint[], muted: boolean): DataBreakpoint[] {
  return list.map((f) => ({
    dataId: f.dataId,
    accessType: f.accessType,
    condition: f.condition?.trim() || null,
    hitCondition: f.hitCondition?.trim() || null,
    enabled: f.enabled && !muted,
  }));
}

let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(() => void syncSpecial(), 120);
}

export async function syncSpecial() {
  if (!isTauri() || !useSpecialBreakpoints.getState().root || useProject.getState().project?.trusted === false) return;
  const { methods, fields } = useSpecialBreakpoints.getState();
  const muted = useBreakpoints.getState().muted;
  try {
    const [m, f] = await Promise.all([
      call(commands.debugSetFunctionBreakpoints(toFunctionBreakpoints(methods, muted))),
      call(commands.debugSetDataBreakpoints(toDataBreakpoints(fields, muted))),
    ]);
    useSpecialBreakpoints.setState((s) => {
      const status = { ...s.status };
      methods.forEach(
        (b, i) => m[i] && (status[b.id] = { verified: m[i].verified, message: m[i].message, line: b.line ?? 0 }),
      );
      fields.forEach(
        (b, i) => f[i] && (status[b.id] = { verified: f[i].verified, message: f[i].message, line: b.line ?? 0 }),
      );
      return { status };
    });
  } catch (e) {
    console.warn("syncing method breakpoints / watchpoints failed", e);
  }
}

export function loadSpecialBreakpoints(root: string | null) {
  let data = { methods: [] as MethodBreakpoint[], fields: [] as FieldWatchpoint[] };
  if (root) {
    try {
      data = sanitizeSpecial(JSON.parse(localStorage.getItem(STORAGE_PREFIX + root) ?? "{}"));
    } catch {
      // Corrupt entry: start empty.
    }
  }
  useSpecialBreakpoints.setState({ root, ...data, status: {} });
  scheduleSync();
}

function setLists(next: Partial<Pick<SpecialState, "methods" | "fields">>) {
  useSpecialBreakpoints.setState(next);
  persist();
  scheduleSync();
}

export function addMethodBreakpoint(name: string, at: { path: string; line: number } | null = null): MethodBreakpoint {
  const bp: MethodBreakpoint = {
    id: newBreakpointId(),
    kind: "method",
    name: name.trim(),
    path: at?.path ?? null,
    line: at?.line ?? null,
    enabled: true,
    condition: null,
    hitCondition: null,
  };
  setLists({ methods: [...useSpecialBreakpoints.getState().methods, bp] });
  return bp;
}

export function addFieldWatchpoint(
  props: { dataId: string; label: string; accessType?: AccessType | null },
  at: { path: string; line: number } | null = null,
): FieldWatchpoint {
  const existing = useSpecialBreakpoints.getState().fields.find((f) => f.dataId === props.dataId);
  if (existing) return existing;
  const bp: FieldWatchpoint = {
    id: newBreakpointId(),
    kind: "field",
    dataId: props.dataId,
    label: props.label,
    accessType: props.accessType ?? null,
    path: at?.path ?? null,
    line: at?.line ?? null,
    enabled: true,
    condition: null,
    hitCondition: null,
  };
  setLists({ fields: [...useSpecialBreakpoints.getState().fields, bp] });
  return bp;
}

export function updateSpecial(
  id: string,
  patch: Partial<Omit<MethodBreakpoint, "id" | "kind">> | Partial<Omit<FieldWatchpoint, "id" | "kind">>,
) {
  const { methods, fields } = useSpecialBreakpoints.getState();
  setLists({
    methods: methods.map((m) => (m.id === id ? ({ ...m, ...patch } as MethodBreakpoint) : m)),
    fields: fields.map((f) => (f.id === id ? ({ ...f, ...patch } as FieldWatchpoint) : f)),
  });
}

export function removeSpecial(id: string) {
  const { methods, fields } = useSpecialBreakpoints.getState();
  setLists({ methods: methods.filter((m) => m.id !== id), fields: fields.filter((f) => f.id !== id) });
}

export function removeAllSpecial() {
  setLists({ methods: [], fields: [] });
}

/** Method breakpoints / watchpoints whose gutter icon is in `path`. */
export function specialAt(path: string): SpecialBreakpoint[] {
  const { methods, fields } = useSpecialBreakpoints.getState();
  return [...methods, ...fields].filter((b) => b.path === path && b.line != null);
}

/** Toggles the method breakpoint on `path:line` (adds `name` when there is none). */
export function toggleMethodAt(path: string, line: number, name: string): MethodBreakpoint | null {
  const existing = useSpecialBreakpoints.getState().methods.find((m) => m.path === path && m.line === line);
  if (existing) {
    removeSpecial(existing.id);
    return null;
  }
  return addMethodBreakpoint(name, { path, line });
}

export function toggleFieldAt(
  path: string,
  line: number,
  props: { dataId: string; label: string },
): FieldWatchpoint | null {
  const existing = useSpecialBreakpoints.getState().fields.find((f) => f.path === path && f.line === line);
  if (existing) {
    removeSpecial(existing.id);
    return null;
  }
  return addFieldWatchpoint({ ...props, accessType: "write" }, { path, line });
}

/** Moves gutter lines after an edit in `path` (see `mapLines`). */
export function setSpecialLines(path: string, moved: ReadonlyArray<{ id: string; line: number }>) {
  const lines = new Map(moved.map((m) => [m.id, m.line]));
  const { methods, fields } = useSpecialBreakpoints.getState();
  const touch = <T extends SpecialBreakpoint>(b: T): T => {
    if (b.path !== path) return b;
    const line = lines.get(b.id);
    // Merged away by the edit (its line was deleted together with another breakpoint's).
    if (line === undefined) return { ...b, path: null, line: null };
    return line === b.line ? b : { ...b, line };
  };
  const nextMethods = methods.map(touch);
  const nextFields = fields.map(touch);
  if (nextMethods.every((m, i) => m === methods[i]) && nextFields.every((f, i) => f === fields[i])) return;
  setLists({ methods: nextMethods, fields: nextFields });
}

// Muting applies to these too.
useBreakpoints.subscribe((s, prev) => {
  if (s.muted !== prev.muted) scheduleSync();
});
