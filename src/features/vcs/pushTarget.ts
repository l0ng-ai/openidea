import type { RemoteOp } from "@/bindings";

export type PushOp = Extract<RemoteOp, { op: "push" | "pushBranch" | "pushSelected" }>;

/** Match configured remote names, including names with a slash. */
export function splitTracked(tracked: string, remotes: readonly string[] = []): { remote: string; branch: string } {
  let matched = "";
  for (const remote of remotes) {
    if (remote.length > matched.length && tracked.startsWith(`${remote}/`)) matched = remote;
  }
  if (matched) return { remote: matched, branch: tracked.slice(matched.length + 1) };
  const slash = tracked.indexOf("/");
  return { remote: tracked.slice(0, slash), branch: tracked.slice(slash + 1) };
}
