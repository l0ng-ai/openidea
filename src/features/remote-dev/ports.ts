/**
 * Remote ports forwarded to this machine, remembered per host (or dev container) and folder and
 * forwarded again on reconnect. A dev container also forwards its `forwardPorts` on its own.
 */
import { create } from "zustand";
import type { ForwardedPort } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";

const SAVED_KEY = "openidea.remote.ports:";

function savedKey(): string | null {
  const session = useRemote.getState().session;
  switch (session?.target.kind) {
    case "ssh":
      return `${SAVED_KEY}${session.target.config}:${session.root}`;
    case "devContainer":
      return `${SAVED_KEY}devcontainer:${JSON.stringify([session.target.folder, session.target.config])}`;
    default:
      return null;
  }
}

export function savedPorts(): number[] {
  const key = savedKey();
  if (!key) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536) : [];
  } catch {
    return [];
  }
}

function save(ports: readonly ForwardedPort[]) {
  const key = savedKey();
  if (!key) return;
  try {
    // A port of another host comes from `forwardPorts`, which forwards it on every connection.
    const own = ports.filter((p) => !p.host).map((p) => p.remotePort);
    if (own.length) localStorage.setItem(key, JSON.stringify(own));
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export const usePorts = create<{ ports: ForwardedPort[] }>(() => ({ ports: [] }));

/** Reads the forwarded ports; `remember` keeps them for the next connection (after the user changed them). */
export async function refreshPorts(remember = false): Promise<void> {
  const session = useRemote.getState().session;
  const ports = await commands.remoteForwardedPorts().catch(() => []);
  if (useRemote.getState().session !== session) return;
  usePorts.setState({ ports });
  if (remember) save(ports);
}

/** A port number typed by the user, or null. */
export function parsePort(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

export async function forwardPort(port: number): Promise<ForwardedPort | null> {
  if (useRemote.getState().session?.target.kind === "wsl") {
    notifications().notify({
      group: "remote",
      level: "error",
      title: tx("Forwarding ports is not supported in a WSL project yet"),
    });
    return null;
  }
  try {
    const forwarded = await call(commands.remoteForwardPort(port));
    await refreshPorts(true);
    return forwarded;
  } catch (e) {
    notifications().notify({
      group: "remote",
      level: "error",
      title: tx`Could not forward port ${port}`,
      body: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** `host`: the host the port belongs to (a Compose service), null for the remote host itself. */
export async function stopForwarding(port: number, host: string | null = null): Promise<void> {
  await call(commands.remoteStopForwarding(port, host)).catch(() => {});
  await refreshPorts(true);
}

/** After (re)connecting: forwards the ports this host and folder had forwarded before. */
export async function restorePorts(): Promise<void> {
  const session = useRemote.getState().session;
  const saved = savedPorts();
  for (const port of saved) {
    if (useRemote.getState().session !== session) return;
    await call(commands.remoteForwardPort(port)).catch(() => null);
  }
  const ports = await commands.remoteForwardedPorts().catch(() => []);
  if (useRemote.getState().session === session) usePorts.setState({ ports });
}
