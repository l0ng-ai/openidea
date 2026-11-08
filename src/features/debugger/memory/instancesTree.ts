/** Rows of the instances tree, built from what `instancesState` has loaded so far. */
import type { JvmBackendState, JvmInspectUnavailable, JvmObjectRef, JvmValue } from "@/platform/ipc";
import { tx as catalogTx } from "@/platform/i18n";
import { referrersKey, type NodeEntry } from "./instancesState";
import { formatJvmValue, objectRef, refKey } from "./values";

/** A component passes its `useTx()`: message rows keep their text, so they must be rebuilt for a new locale. */
type Tx = typeof catalogTx;

export type Retry = { what: "fields" | "referrers"; ref: JvmObjectRef };

export type PaneNode =
  | {
      kind: "value";
      key: string;
      value: JvmValue;
      /** `null` for values without fields to open (null, primitives). */
      ref: JvmObjectRef | null;
      /** Field name, or `null` for an instance or a referrer. */
      name: string | null;
      /** Fields through which a referrer points at its parent object. */
      via: string[] | null;
    }
  | { kind: "referrers"; key: string; ref: JvmObjectRef }
  | { kind: "message"; key: string; text: string; retry: Retry | null };

export function outdatedText(tx: Tx = catalogTx): string {
  return tx("These values are from before the last stop. Show the instances again to update them.");
}

export function inspectUnavailableText(reason: JvmInspectUnavailable, tx: Tx = catalogTx): string {
  switch (reason.kind) {
    case "noBackend":
      return tx("This debugger cannot list instances.");
    case "unsupported": {
      const detail = reason.detail;
      return tx`The debugger cannot list instances: ${detail}`;
    }
    case "notSuspended":
      return tx("Pause the program to see instances.");
    case "stale":
      return outdatedText(tx);
    case "collected":
      return tx("The object has been garbage collected.");
    case "classNotLoaded":
      return tx("The class is not loaded in the JVM.");
    case "vmNotFound":
      return tx("Could not tell which JVM this session debugs.");
    case "timedOut":
      return tx("The JVM did not answer in time.");
    case "backendClosed":
      return tx("The connection to the JVM is closed.");
  }
}

/** Banner for a session whose instance backend stopped; `null` while it works. */
export function backendText(state: JvmBackendState | undefined, tx: Tx = catalogTx): string | null {
  switch (state?.kind) {
    case "unsupported": {
      const detail = state.detail;
      return tx`The debugger cannot list instances: ${detail}`;
    }
    case "degraded":
      return tx("The debugger link stopped reading the JVM. Debugging continues.");
    case "closed":
      return tx("The connection to the JVM is closed.");
    default:
      return null;
  }
}

const valueNode = (key: string, generation: number, value: JvmValue, name: string | null, via: string[] | null) =>
  ({ kind: "value", key, value, ref: objectRef(generation, value), name, via }) satisfies PaneNode;

const message = (key: string, text: string, retry: Retry | null = null): PaneNode => ({
  kind: "message",
  key,
  text,
  retry,
});

export function instanceNodes(generation: number, instances: readonly JvmValue[]): PaneNode[] {
  return instances.map((v, i) => valueNode(`#${i}`, generation, v, null, null));
}

export function labelOf(node: PaneNode, tx: Tx = catalogTx): string {
  switch (node.kind) {
    case "value": {
      const text = formatJvmValue(node.value);
      return node.via?.length ? `${text} · ${node.via.join(", ")}` : text;
    }
    case "referrers":
      return tx("Referrers");
    case "message":
      return node.text;
  }
}

/** Loaded children of `node`, or `undefined` while there is nothing to show yet (the tree shows "Loading…"). */
export function childrenOf(
  node: PaneNode,
  nodes: Readonly<Record<string, NodeEntry>>,
  tx: Tx = catalogTx,
): PaneNode[] | undefined {
  if (node.kind === "message" || !node.ref) return undefined;
  const ref = node.ref;
  const n = nodes[refKey(ref)];
  if (!n) return undefined;
  if (node.kind === "referrers") return referrerChildren(node.key, ref, n, tx);

  const out: PaneNode[] = [];
  const fields = n.fields;
  if (fields?.status === "ready") {
    fields.fields.forEach((f, i) => out.push(valueNode(`${node.key}/${i}`, ref.generation, f.value, f.name, null)));
  } else if (fields) {
    const retry = fields.reason.kind === "timedOut" ? { what: "fields" as const, ref } : null;
    out.push(message(`${node.key}/!fields`, inspectUnavailableText(fields.reason, tx), retry));
  } else if (n.loadingFields) {
    if (!n.referrers && !n.loadingReferrers) return undefined;
    out.push(message(`${node.key}/!loading`, tx("Loading…")));
  } else if (n.error) {
    out.push(message(`${node.key}/!error`, n.error, { what: "fields", ref }));
  }
  if (n.referrers || n.loadingReferrers) out.push({ kind: "referrers", key: referrersKey(node.key), ref });
  return fields || out.length ? out : undefined;
}

function referrerChildren(key: string, ref: JvmObjectRef, n: NodeEntry, tx: Tx): PaneNode[] | undefined {
  const r = n.referrers;
  if (!r)
    return n.error && !n.loadingReferrers ? [message(`${key}/!error`, n.error, { what: "referrers", ref })] : undefined;
  if (r.status === "unavailable") {
    const retry = r.reason.kind === "timedOut" ? { what: "referrers" as const, ref } : null;
    return [message(`${key}/!reason`, inspectUnavailableText(r.reason, tx), retry)];
  }
  if (!r.referrers.length) return [message(`${key}/!none`, tx("No referrers"))];
  return r.referrers.map((x, i) => valueNode(`${key}/${i}`, ref.generation, x.value, null, x.via));
}
