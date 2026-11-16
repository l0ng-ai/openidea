import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { RemoteSession } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { BarButton, Icon, Spinner } from "@/ui";
import styles from "./RemoteDev.module.css";

const BADGE: Record<RemoteSession["target"]["kind"], string> = {
  ssh: "SSH",
  wsl: "WSL",
  devContainer: "Dev Container",
};

/** Status bar label of a remote window: where its project runs. */
export function remoteBadge(session: Pick<RemoteSession, "target" | "host">): string {
  return `${BADGE[session.target.kind]}: ${session.host}`;
}

export function RemoteStatus() {
  const session = useRemote((s) => s.session);
  const lost = useRemote((s) => s.lost !== null);
  const reconnecting = useRemote((s) => s.reconnecting);
  if (!session) return null;
  const label = remoteBadge(session);
  if (lost)
    return (
      <BarButton
        tooltip={
          reconnecting
            ? tx`Reconnecting to ${session.host}…`
            : tx`Lost the connection to ${session.host}. Click to reconnect.`
        }
        aria-label={tx`${label} (disconnected)`}
        disabled={reconnecting}
        onClick={() => void executeAction("remote.reconnect")}
      >
        <span className={styles.lost}>
          {reconnecting ? <Spinner size={10} /> : <Icon name="warning" size={13} />}
          {label}
        </span>
      </BarButton>
    );
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
