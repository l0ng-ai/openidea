import { tx } from "@/platform/i18n";
import { useRemote } from "@/platform/remote";
import { Row, SettingNumber } from "../components/Form";
import { REMOTE_IDLE_MINUTES } from "../model/schema";
import type { PageSpec } from "./spec";
import { TOOLS_GROUP } from "./tools";

function IdleTimeout() {
  const session = useRemote((s) => s.session);
  const disconnected = useRemote((s) => s.lost !== null);
  const seconds = session?.idlePolicy?.overrideSeconds;
  if (session && !disconnected && seconds != null) {
    const host = session.host;
    return (
      <Row label="Idle timeout" hint={tx`Set by OPENIDEA_SERVER_IDLE_TIMEOUT_SECONDS on ${host}.`}>
        {tx`${seconds} seconds`}
      </Row>
    );
  }
  const host = session?.host;
  const hint = !session
    ? tx("Open Settings in a remote project window to change its backend timeout.")
    : disconnected
      ? tx("Reconnect to the remote host to change its backend timeout.")
      : !session.idlePolicy
        ? tx("This backend does not support a configurable idle timeout.")
        : tx`After the last window disconnects, the backend on ${host} stops after this many minutes without active terminals, runs, debug sessions, or agent tasks.`;
  return (
    <SettingNumber
      k="remoteDevelopment.idleTimeoutMinutes"
      label="Idle timeout"
      {...REMOTE_IDLE_MINUTES}
      integer
      unit="min"
      disabled={!session?.idlePolicy || disconnected}
      hint={hint}
    />
  );
}

export const REMOTE_DEVELOPMENT_PAGE: PageSpec = {
  id: "tools.remoteDevelopment",
  title: "Remote Development",
  group: TOOLS_GROUP,
  order: 604,
  keywords: ["SSH", "WSL", "dev container", "disconnect", "shutdown", "idle timeout"],
  sections: [{ title: "Remote backend", options: [{ kind: "custom", label: "Idle timeout", component: IdleTimeout }] }],
};
