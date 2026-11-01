import { IpcError } from "./ipc";

export type ProjectTrustScope = "current" | "local";

let prompt: ((path: string, scope: ProjectTrustScope) => Promise<boolean>) | null = null;

export function provideProjectTrustPrompt(
  value: (path: string, scope: ProjectTrustScope) => Promise<boolean>,
): () => void {
  prompt = value;
  return () => {
    if (prompt === value) prompt = null;
  };
}

export async function confirmProjectTrust(path: string, scope: ProjectTrustScope = "current"): Promise<void> {
  if (prompt && !(await prompt(path, scope))) {
    throw new IpcError({ kind: "cancelled", message: "Project opening cancelled" });
  }
}
