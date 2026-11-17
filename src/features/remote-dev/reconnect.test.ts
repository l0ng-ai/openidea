import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteSession } from "@/platform/ipc";

const listeners = vi.hoisted(() => new Map<string, (event: { host: string }) => void>());
const reconnectRemote = vi.hoisted(() => vi.fn<() => Promise<void>>());
const notify = vi.hoisted(() => vi.fn());
const dirty = vi.hoisted(() => ({ ids: [] as number[] }));
const confirm = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/platform/ipc", async (orig) => ({
  ...(await orig<typeof import("@/platform/ipc")>()),
  onIdeEvent: (type: string, handler: (event: { host: string }) => void) => {
    listeners.set(type, handler);
    return () => listeners.delete(type);
  },
}));
vi.mock("@/platform/remote", async (orig) => ({
  ...(await orig<typeof import("@/platform/remote")>()),
  reconnectRemote,
}));
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify, expire: vi.fn() }),
  maybeEditorService: () => ({ dirtyDocumentIds: () => dirty.ids }),
}));
vi.mock("@/workbench/messages", () => ({ confirm }));

import { getContext } from "@/platform/context";
import { useRemote } from "@/platform/remote";
import { installReconnect, reconnectNow, RETRY_DELAYS_MS } from "./reconnect";

const session: RemoteSession = {
  target: { kind: "ssh", config: "box" },
  root: "/srv/app",
  host: "box",
  os: "linux",
  commands: [],
};

let waits: number[];
let uninstall: () => void;

beforeEach(() => {
  waits = [];
  dirty.ids = [];
  useRemote.setState({ session, lost: null, reconnecting: false });
  uninstall = installReconnect(async (ms) => {
    waits.push(ms);
  });
});

afterEach(() => {
  uninstall();
  vi.clearAllMocks();
});

const lose = () => listeners.get("remoteConnectionLost")!({ host: "box" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("marks the window lost and reconnects in the background", async () => {
  reconnectRemote.mockRejectedValueOnce(new Error("Network is unreachable")).mockResolvedValueOnce();
  lose();
  expect(useRemote.getState().lost).toBe("box");
  expect(getContext().remoteConnectionLost).toBe(true);
  await settle();
  expect(waits).toEqual(RETRY_DELAYS_MS.slice(0, 2));
  expect(reconnectRemote).toHaveBeenCalledTimes(2);
  expect(notify).not.toHaveBeenCalled();
});

it("offers Reconnect once every attempt failed", async () => {
  reconnectRemote.mockRejectedValue(new Error("Connection refused"));
  lose();
  await settle();
  expect(reconnectRemote).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length);
  expect(notify).toHaveBeenCalledOnce();
  const n = notify.mock.calls[0]![0];
  expect(n).toMatchObject({ level: "error", title: "Lost the connection to box", body: "Connection refused" });

  reconnectRemote.mockResolvedValueOnce();
  n.actions[0].run();
  await settle();
  expect(reconnectRemote).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  expect(confirm).not.toHaveBeenCalled();
});

it("leaves the reload to the user while edits are unsaved, and asks first", async () => {
  dirty.ids = [3, 4];
  lose();
  await settle();
  expect(reconnectRemote).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Lost the connection to box" }));

  confirm.mockResolvedValueOnce(false);
  await reconnectNow();
  expect(confirm).toHaveBeenCalledOnce();
  expect(reconnectRemote).not.toHaveBeenCalled();
});

it("stops reconnecting on its own once a file is edited while it waits", async () => {
  uninstall();
  reconnectRemote.mockRejectedValueOnce(new Error("Network is unreachable"));
  uninstall = installReconnect(async (ms) => {
    waits.push(ms);
    // Edited during the second wait.
    if (waits.length === 2) dirty.ids = [7];
  });
  lose();
  await settle();
  expect(reconnectRemote).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Lost the connection to box" }));
});

it("ignores a lost connection of a window that is no longer remote", async () => {
  useRemote.setState({ session: null });
  lose();
  await settle();
  expect(useRemote.getState().lost).toBeNull();
  expect(reconnectRemote).not.toHaveBeenCalled();
});
