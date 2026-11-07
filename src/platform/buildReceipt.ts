/**
 * A successful Before launch "Build Project" covers every module of the project, so Java
 * launches that run immediately afterwards need not build the same project again. The
 * receipt is scoped to the project root, expires quickly, is consumed once by the
 * top-level launch and cleared when a new one starts; children of a compound can reuse it.
 */
const TTL_MS = 30_000;

let receipt: { root: string; at: number } | null = null;

export function recordProjectBuild(root: string): void {
  receipt = root ? { root, at: Date.now() } : null;
}

/** Whether the last Build Project still covers `root`; a top-level launch consumes it once. */
export function consumeProjectBuild(root: string, oneShot = false): boolean {
  if (!receipt || receipt.root !== root || Date.now() - receipt.at > TTL_MS) return false;
  if (oneShot) receipt = null;
  return true;
}

/** A new top-level launch must not inherit a Build Project receipt from an earlier one. */
export function clearProjectBuild(): void {
  receipt = null;
}
