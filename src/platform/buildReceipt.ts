/**
 * A successful Before launch "Build Project" covers every module of the project, so a
 * Java launch that runs immediately afterwards need not build the same project again.
 * The receipt is scoped to the project root and expires quickly; any explicit build
 * policy (Make, Rebuild, …) still builds as asked.
 */
const TTL_MS = 30_000;

let receipt: { root: string; at: number } | null = null;

export function recordProjectBuild(root: string): void {
  receipt = root ? { root, at: Date.now() } : null;
}

/** True once for the project the last Build Project just built. */
export function consumeProjectBuild(root: string): boolean {
  const current = receipt;
  receipt = null;
  return !!current && current.root === root && Date.now() - current.at <= TTL_MS;
}
