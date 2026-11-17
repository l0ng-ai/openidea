/**
 * Diagnostics computed in the UI (Typo, file references, SQL inspections), as
 * full per-(file, producer) replacements like the backend's `diagnostics`
 * event, so the Problems view sees them as well as the editor.
 */
import type { Diagnostic } from "@/bindings";
import { notifyEach } from "./listeners";

type Listener = (path: string, producer: string, items: readonly Diagnostic[]) => void;

const listeners = new Set<Listener>();

export function publishLocalDiagnostics(path: string, producer: string, items: readonly Diagnostic[]) {
  notifyEach(listeners, (l) => l(path, producer, items), "local diagnostics");
}

export function onLocalDiagnostics(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
