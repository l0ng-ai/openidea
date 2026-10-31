/**
 * Plain-browser development aid (`pnpm dev` without Tauri): injects a fake
 * project so the workbench and features render for visual review. Features
 * fall back to in-memory backends in this mode. Never loaded under Tauri or
 * in production builds (except `--mode perf`, used by the performance harness).
 */
import { useProject } from "@/platform/project";

export function registerDevSamples(): () => void {
  if (!useProject.getState().project) {
    useProject.setState({
      project: { root: "/dev/acme-api", name: "acme-api", trusted: true, isGit: true, settings: {} as never },
    });
  }
  return () => {};
}
