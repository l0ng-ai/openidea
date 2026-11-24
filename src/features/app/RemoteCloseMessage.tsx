import { useEffect, useState } from "react";
import { useTx } from "@/platform/i18n";
import { call, commands, type RemoteSession } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { formatIdleDuration } from "@/platform/remoteIdle";

/** Read the host's current setting without blocking any of the close choices on a slow connection. */
export function RemoteCloseMessage({ session }: { session: RemoteSession }) {
  const tr = useTx();
  const { host, idlePolicy } = session;
  const override = idlePolicy?.overrideSeconds;
  const [minutes, setMinutes] = useState<number | "unavailable" | null>(null);
  const canRead = session.commands.includes("remote_idle_timeout_minutes");
  useEffect(() => {
    if (!idlePolicy || override != null || !canRead || useRemote.getState().session !== session) return;
    let active = true;
    void call(commands.remoteIdleTimeoutMinutes()).then(
      (n) => {
        if (active) setMinutes(n);
      },
      () => {
        if (active) setMinutes("unavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [session, idlePolicy, override, canRead]);

  const seconds = override ?? (typeof minutes === "number" ? minutes * 60 : null);
  const duration = seconds != null && seconds > 0 ? formatIdleDuration(seconds) : null;
  const summary =
    seconds === 0
      ? tr`Idle shutdown is off on ${host}.`
      : duration !== null
        ? tr`If kept running, the backend stops after ${duration} idle.`
        : !canRead || minutes === "unavailable"
          ? tr("The host’s idle timeout is unavailable.")
          : tr("Checking the host’s idle timeout…");
  return (
    <>
      {tr`Keep the IDE backend on ${host} running so you can reconnect later, or stop it and end its terminals, runs and agent tasks.`}
      {idlePolicy && (
        <>
          {"\n\n"}
          <span role="status">{summary}</span>
        </>
      )}
    </>
  );
}
