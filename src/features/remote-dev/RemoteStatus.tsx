import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { RemoteSession } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { BarButton } from "@/ui";

/** Status bar label of a remote window: where its project runs. */
export function remoteBadge(session: Pick<RemoteSession, "target" | "host">): string {
  return `${session.target.kind === "wsl" ? "WSL" : "SSH"}: ${session.host}`;
}

export function RemoteStatus() {
  const session = useRemote((s) => s.session);
  if (!session) return null;
  const label = remoteBadge(session);
  return (
    <BarButton
      tooltip={tx`Project runs on ${label}`}
      aria-label={label}
      onClick={() => void executeAction("remote.connect")}
    >
      {label}
    </BarButton>
  );
}
