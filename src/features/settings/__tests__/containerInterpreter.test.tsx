import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerPython } from "@/bindings";

const mocks = vi.hoisted(() => ({
  container: vi.fn(),
  refresh: vi.fn(),
  packages: vi.fn(),
  effective: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      sdkDetect: vi.fn(async () => ({ status: "ok", data: [] })),
      sdkContainerPython: mocks.container,
      sdkContainerPythonRefresh: mocks.refresh,
      sdkPythonPackages: mocks.packages,
      sdkPythonEffective: mocks.effective,
    },
  };
});

const { PageContext } = await import("../components/context");
const { PythonInterpreterPage } = await import("../languages/PythonInterpreterPage");
const { interpreterTarget, targetChoices, useSdks } = await import("../languages/api");
const { DEFAULT_SETTINGS } = await import("../model/schema");
const { useSettingsDialog } = await import("../model/staging");
const { DEFAULT_RUN_TARGET } = await import("@/platform/remoteSettings");

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const SNAPSHOT: ContainerPython = {
  target: "web",
  name: "Compose web",
  version: "3.12.7",
  image: "sha256:0123456789abcdef",
  folders: ["/cache/web/0123/fs/usr/local/lib/python3.12/site-packages"],
  packages: [
    { name: "Django", version: "5.1.3" },
    { name: "asgiref", version: "3.8.1" },
  ],
  updating: false,
};
const TARGETS = [
  { ...DEFAULT_RUN_TARGET, kind: "compose" as const, id: "web", name: "Compose web", service: "web" },
  { ...DEFAULT_RUN_TARGET, kind: "ssh" as const, id: "box", name: "Build box" },
];

function mount(interpreter: string) {
  const settings = structuredClone(DEFAULT_SETTINGS) as typeof DEFAULT_SETTINGS & Record<string, unknown>;
  settings.languages.python.interpreter = interpreter;
  settings.runTargets = TARGETS;
  useSettingsDialog.setState({ base: settings, globalBase: structuredClone(DEFAULT_SETTINGS), staged: {}, query: "" });
  render(
    <PageContext.Provider value={{ pageId: "python.interpreter", scope: "project" }}>
      <PythonInterpreterPage />
    </PageContext.Provider>,
  );
}

beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 1 } });
  useSdks.setState({ byKind: { python: [] }, loading: {}, errors: {} });
  mocks.container.mockResolvedValue(ok(SNAPSHOT));
  mocks.refresh.mockResolvedValue(ok(SNAPSHOT));
  mocks.effective.mockResolvedValue(ok(null));
  mocks.packages.mockResolvedValue(ok([]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("run target interpreter", () => {
  it("names Docker and Compose targets only", () => {
    expect(targetChoices(TARGETS)).toEqual([
      { value: "target:web", label: "Compose web", verbatim: true, detail: "Docker Compose service web" },
    ]);
    expect(interpreterTarget(" target:web ")).toBe("web");
    for (const local of ["", "target:", "/usr/bin/python3", null]) expect(interpreterTarget(local)).toBeNull();
  });

  it("lists the snapshot's packages read-only", async () => {
    mount("target:web");
    expect(await screen.findByText("Django")).toBeInTheDocument();
    expect(screen.getByText("Compose web — Python 3.12.7 · 0123456789ab")).toBeInTheDocument();
    expect(screen.getByText(/read-only here/)).toBeInTheDocument();
    for (const name of ["Install", "Uninstall", "Upgrade"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(mocks.packages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy Libraries from the Container Again" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it("offers the container targets in the interpreter list", async () => {
    mount("");
    fireEvent.click(screen.getByRole("button", { name: "Python interpreter" }));
    expect(await screen.findByRole("option", { name: /Compose web/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Build box/ })).toBeNull();
    expect(mocks.container).not.toHaveBeenCalled();
  });
});
