import { afterEach, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/bindings";
import { commands } from "@/platform/ipc";
import { usePlugins } from "../store";
import { webPtyBackend } from "../views/ptyBackend";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (data: string) => void;
  },
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<object>()),
  isTauri: () => true,
  commands: { pluginWebPtySpawn: vi.fn(async () => ({ status: "ok", data: { id: 42 } })) },
}));

afterEach(() => {
  usePlugins.setState({ plugins: [] });
  vi.clearAllMocks();
});

it("uses the plugin-scoped backend for both log and frame streams, rechecking the current grant", async () => {
  const plugin = { id: "probe", enabled: true, capabilities: [{ id: "process:bash", granted: true }] } as PluginInfo;
  const command = { program: "bash", args: [], env: {}, cols: 240, rows: 40 };
  const backend = webPtyBackend("probe", "logs");
  usePlugins.setState({ plugins: [plugin] });
  const output = vi.fn();
  await expect(backend.spawn(command, output)).resolves.toEqual({ id: 42 });
  expect(commands.pluginWebPtySpawn).toHaveBeenCalledWith(
    "probe",
    "logs",
    command,
    expect.objectContaining({ onmessage: output }),
  );
  for (const p of [
    { ...plugin, capabilities: [] },
    { ...plugin, enabled: false },
  ]) {
    usePlugins.setState({ plugins: [p] });
    await expect(backend.spawn(command, output)).rejects.toThrow("capability not granted");
  }
  expect(commands.pluginWebPtySpawn).toHaveBeenCalledOnce();
});
