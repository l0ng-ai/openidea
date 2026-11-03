/** Host platform, from the backend when running in the desktop app. */
import { commands, isTauri, type BuildInfo } from "@/platform/ipc";

export type HostOs = "macos" | "windows" | "linux" | "web";

export { guessOs } from "@/platform/platformInfo";
import { guessOs } from "@/platform/platformInfo";

function normalize(os: string): HostOs {
  return os === "macos" || os === "windows" || os === "linux" ? os : "linux";
}

let info: Promise<BuildInfo | null> | null = null;

export function buildInfo(): Promise<BuildInfo | null> {
  info ??= isTauri()
    ? commands.appBuildInfo().catch(() => {
        info = null;
        return null;
      })
    : Promise.resolve(null);
  return info;
}

export async function hostOs(): Promise<HostOs> {
  const b = await buildInfo();
  return b ? normalize(b.os) : guessOs();
}
