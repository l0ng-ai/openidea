import { IpcError } from "./ipc";

let prompt: ((path: string) => Promise<boolean>) | null = null;

export function provideProjectTrustPrompt(value: (path: string) => Promise<boolean>): () => void {
  prompt = value;
  return () => {
    if (prompt === value) prompt = null;
  };
}

export async function confirmProjectTrust(path: string): Promise<void> {
  if (prompt && !(await prompt(path))) {
    throw new IpcError({ kind: "cancelled", message: "Project opening cancelled" });
  }
}
