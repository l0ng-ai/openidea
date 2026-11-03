import { tx } from "@/platform/i18n";
import type { RunConfig } from "@/platform/ipc";
import { startRun } from "./store";

export async function runUpdateBuild(build: RunConfig): Promise<void> {
  let finish!: (ok: boolean) => void;
  const exited = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const session = await startRun(build, undefined, undefined, {
    onExit: (code, stopped) => finish(code === 0 && !stopped),
  });
  if (!session || session.status === "failed" || !(await exited))
    throw new Error(tx("Application update build failed"));
}
