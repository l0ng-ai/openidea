/** Read-only remote snapshots for the deployment comparison; project files are never downloaded over. */
import { call, commands, type SyncEntry } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { deploymentConnection, type DeploymentServerValid } from "@/platform/remoteSettings";
import type { DiffData } from "@/features/vcs/diffInput";
import { withSsh } from "./ssh";

const PREVIEW_LIMIT = 8 * 1024 * 1024;
const BLOCK_SIZE = 64 * 1024;

export type DeploymentPreview = { kind: "text"; data: DiffData } | { kind: "binary" } | { kind: "tooLarge" };

export function createDeploymentComparison(server: DeploymentServerValid, root: string) {
  // Only the downloaded path is cached, never a live remote document. The diff
  // receives immutable text, so its merge controls cannot save to the server.
  const snapshots = new Map<string, Promise<string>>();
  const localPath = (entry: SyncEntry) => `${root.replace(/\/$/, "")}/${entry.path}`;
  const remoteSnapshot = (entry: SyncEntry) => {
    let pending = snapshots.get(entry.remotePath);
    if (!pending) {
      pending = withSsh(server.kind === "sftp" ? server.sshConfig : "", () =>
        call(commands.remoteOpen(deploymentConnection(server), entry.remotePath)),
      );
      snapshots.set(entry.remotePath, pending);
      void pending.catch(() => snapshots.delete(entry.remotePath));
    }
    return pending;
  };

  return {
    async preview(entry: SyncEntry, signal: AbortSignal): Promise<DeploymentPreview> {
      signal.throwIfAborted();
      if (Math.max(entry.local?.size ?? 0, entry.remote?.size ?? 0) > PREVIEW_LIMIT) return { kind: "tooLarge" };
      const remote = entry.remote ? await remoteSnapshot(entry) : null;
      signal.throwIfAborted();
      const probes = await Promise.all(
        [entry.local ? localPath(entry) : null, remote].map((path) => (path ? call(commands.fsProbe(path)) : null)),
      );
      signal.throwIfAborted();
      if (probes.some((p) => p?.binary)) return { kind: "binary" };
      if (probes.some((p) => p?.tooLarge || (p?.size ?? 0) > PREVIEW_LIMIT)) return { kind: "tooLarge" };
      const text = remote ? await call(commands.fsReadText(remote)) : "";
      signal.throwIfAborted();
      return {
        kind: "text",
        data: {
          path: localPath(entry),
          title: entry.path,
          left: entry.local
            ? { type: "file", path: localPath(entry), label: tx`Local: ${entry.path}` }
            : { type: "text", text: "", label: tx("Local: (does not exist)") },
          right: {
            type: "text",
            text,
            label: `${server.name || server.id}: ${entry.remote ? entry.remotePath : tx("(does not exist)")}`,
          },
        },
      };
    },

    /** Exact byte comparison, including binary files and line endings, in bounded reads. */
    async equal(entry: SyncEntry, signal: AbortSignal): Promise<boolean> {
      signal.throwIfAborted();
      if (!entry.local || !entry.remote || entry.local.size !== entry.remote.size) return false;
      const remote = await remoteSnapshot(entry);
      signal.throwIfAborted();
      // Read once for empty files too, to detect files changed since the listing.
      for (let offset = 0; offset === 0 || offset < entry.local.size; offset += BLOCK_SIZE) {
        signal.throwIfAborted();
        const [a, b] = await Promise.all(
          [localPath(entry), remote].map((path) => call(commands.fsReadRange(path, offset, BLOCK_SIZE))),
        );
        signal.throwIfAborted();
        if (a!.total !== entry.local.size || b!.total !== entry.remote.size)
          throw new Error("A file changed during comparison. Refresh and compare again.");
        if (a!.data !== b!.data) return false;
        if (entry.local.size === 0) break;
      }
      return true;
    },
  };
}

export type DeploymentComparison = ReturnType<typeof createDeploymentComparison>;
