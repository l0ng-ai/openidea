import { useWebConnection } from "@/platform/webBridge";
import { Icon, T } from "@/ui";
import styles from "./WebConnectionBanner.module.css";

/** Non-intrusive banner shown in browser mode while the WebSocket reconnects to `openidea-server --web`. */
export function WebConnectionBanner() {
  const active = useWebConnection((s) => s.active);
  const status = useWebConnection((s) => s.status);
  if (!active || status !== "reconnecting") return null;
  return (
    <div className={styles.banner} role="status" aria-live="polite" data-web-reconnecting="">
      <Icon name="warning" size={14} className={styles.icon} />
      <span>
        <T>Connection to OpenIDEA server lost. Reconnecting…</T>
      </span>
    </div>
  );
}
