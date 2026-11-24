import { takeOverWebSession, useWebConnection } from "@/platform/webBridge";
import { Icon, T } from "@/ui";
import styles from "./WebConnectionBanner.module.css";

/** Non-intrusive banner shown in browser mode while reconnecting or superseded by another tab. */
export function WebConnectionBanner() {
  const active = useWebConnection((s) => s.active);
  const status = useWebConnection((s) => s.status);
  if (!active || (status !== "reconnecting" && status !== "superseded")) return null;
  if (status === "superseded") {
    return (
      <div className={styles.banner} role="status" aria-live="polite" data-web-superseded="">
        <Icon name="warning" size={14} className={styles.icon} />
        <span>
          <T>This OpenIDEA session is open in another browser tab.</T>
        </span>
        <button type="button" className={styles.action} onClick={() => takeOverWebSession()}>
          <T>Take Over</T>
        </button>
      </div>
    );
  }
  return (
    <div className={styles.banner} role="status" aria-live="polite" data-web-reconnecting="">
      <Icon name="warning" size={14} className={styles.icon} />
      <span>
        <T>Connection to OpenIDEA server lost. Reconnecting…</T>
      </span>
    </div>
  );
}
