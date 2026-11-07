/**
 * A successful Before launch "Build Project" covers every module of the project, so Java
 * launches that run immediately afterwards need not build the same project again. The
 * receipt is scoped to the project root, expires quickly, and is cleared when a new
 * top-level configuration starts; all children of a compound can reuse it.
 */
const TTL_MS = 30_000;

let receipt: { root: string; at: number } | null = null;

export function recordProjectBuild(root: string): void {
  receipt = root ? { root, at: Date.now() } : null;
}

/** Whether the last Build Project still covers `root` (valid until the next top-level launch). */
export function consumeProjectBuild(root: string): boolean {
  return !!receipt && receipt.root === root && Date.now() - receipt.at <= TTL_MS;
}

/** A new top-level launch must not inherit a Build Project receipt from an earlier one. */
export function clearProjectBuild(): void {
  receipt = null;
}
