import { call, commands } from "@/platform/ipc";

/**
 * The URL web pages of `remote` in `repo` are built from: its fetch URL with any `~/.ssh/config`
 * host alias resolved (`git@github.com-work:o/r` → `git@github.com:o/r`). Null without that remote.
 */
export async function remoteWebSource(repo: string | null, remote: string): Promise<string | null> {
  const remotes = await call(commands.vcsRemotes(repo)).catch(() => null);
  const found = remotes?.find((r) => r.name === remote);
  if (found) return found.resolvedUrl ?? found.url;
  return (await call(commands.vcsConfigGet(repo, `remote.${remote}.url`)).catch(() => null)) || null;
}
