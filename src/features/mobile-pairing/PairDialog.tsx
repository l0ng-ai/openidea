import { useEffect, useState } from "react";
import { call, commands, onIdeEvent, type MobileDevice, type MobilePairing } from "@/platform/ipc";
import { formatDateTime } from "@/platform/dateFormat";
import { tx, useTx } from "@/platform/i18n";
import { Button, copyText, Dialog, Icon, T } from "@/ui";
import { Spinner } from "@/ui/Spinner";
import { closePairDialog, countdown, usePairDialog } from "./model";
import styles from "./PairDialog.module.css";

export function PairHost() {
  const open = usePairDialog((s) => s.open);
  return open ? <PairDialog /> : null;
}

function useDevices(): MobileDevice[] {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      void call(commands.mobileDevices())
        .then((d) => live && setDevices(d))
        .catch(() => {});
    load();
    const off = onIdeEvent("mobileDevicesChanged", load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return devices;
}

function PairDialog() {
  const t = useTx();
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const devices = useDevices();

  const [attempt, setAttempt] = useState(0);
  const newCode = () => {
    setPairing(null);
    setError(null);
    setAttempt((n) => n + 1);
  };
  useEffect(() => {
    let live = true;
    call(commands.mobilePair())
      .then((p) => {
        if (!live) return;
        setPairing(p);
        setLeft(p.expiresInSecs);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (!pairing) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setLeft(Math.max(0, pairing.expiresInSecs - (Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const close = () => {
    void call(commands.mobileCancelPairing()).catch(() => {});
    closePairDialog();
  };
  const expired = pairing !== null && left <= 0;

  return (
    <Dialog
      open
      onClose={close}
      title={t("Pair Mobile Device")}
      width={460}
      buttons={[{ label: "Close", role: "cancel", autoFocus: true }]}
    >
      <div className={styles.content}>
        <div className={styles.pair}>
          <div className={styles.code}>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : pairing && !expired ? (
              <img
                className={styles.qr}
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`}
                alt={t("Pairing QR code")}
              />
            ) : pairing ? (
              <Button onClick={newCode}>
                <T>New Code</T>
              </Button>
            ) : (
              <Spinner label="Creating a pairing code" />
            )}
          </div>
          <div className={styles.steps}>
            <p className={styles.lead}>
              <T>Open OpenIDEA on your phone and scan this code.</T>
            </p>
            <p className={styles.hint}>
              <T>The phone works with this computer's projects, agents, databases and repositories.</T>
            </p>
            <p className={styles.hint}>
              {expired ? (
                <T>The code expired.</T>
              ) : pairing ? (
                <>
                  {tx`The code works once and expires in ${countdown(left)}.`}{" "}
                  <button type="button" className={styles.link} onClick={() => void copyText(pairing.ticket)}>
                    <T>Copy Pairing Code</T>
                  </button>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className={styles.separator}>
          <span>
            <T>Paired Devices</T>
          </span>
        </div>
        {devices.length === 0 ? (
          <p className={styles.empty}>
            <T>No paired devices</T>
          </p>
        ) : (
          <ul className={styles.devices} aria-label={t("Paired Devices")}>
            {devices.map((d) => (
              <li key={d.id} className={styles.device}>
                <Icon name="mobile" size={16} className={styles.deviceIcon} />
                <span className={styles.deviceName}>{d.name}</span>
                <span className={styles.deviceMeta}>
                  {d.online ? t("Connected") : t("Not connected")} ·{" "}
                  {tx`Paired ${formatDateTime(new Date(d.pairedAtMs ?? 0))}`}
                </span>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void call(commands.mobileDeviceRemove(d.id)).catch(() => {})}
                >
                  <T>Remove</T>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
