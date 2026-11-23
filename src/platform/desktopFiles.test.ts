import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDesktopText, writeDesktopText } from "./desktopFiles";
import { useRemote } from "./remote";
import { setInvokeRoute } from "./tauriCore";

const invoke = vi.fn();
const remoteInvoke = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  useRemote.setState({ session: { root: "/srv/project", os: "linux" } as never });
  setInvokeRoute(remoteInvoke);
});

afterEach(() => {
  setInvokeRoute(null);
  useRemote.setState({ session: null });
  vi.unstubAllGlobals();
});

it("reads desktop settings or import files even when project IPC is remote", async () => {
  const path = "C:\\Users\\me\\settings.xml";
  invoke.mockResolvedValueOnce("<settings />");
  await expect(readDesktopText(path)).resolves.toBe("<settings />");
  expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual(["fs_read_text", { path }]);
  expect(remoteInvoke).not.toHaveBeenCalled();
});

it("checks and replaces an existing desktop file on the desktop", async () => {
  const path = "C:\\Users\\me\\scheme.icls";
  invoke.mockResolvedValueOnce("file").mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  await writeDesktopText(path, "é");
  expect(invoke.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ["fs_entry_kind", { path }],
    ["fs_delete", { path }],
    ["fs_create_file_bytes", { path, data: "w6k=" }],
  ]);
  expect(remoteInvoke).not.toHaveBeenCalled();
});
