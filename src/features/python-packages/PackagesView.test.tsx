import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({
  effective: vi.fn(),
  packages: vi.fn(),
  pypi: vi.fn(),
  pip: vi.fn(),
  container: vi.fn(),
  index: vi.fn(),
  cancel: vi.fn(),
  active: null as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      sdkPythonEffective: mocks.effective,
      sdkPythonPackages: mocks.packages,
      sdkPythonPip: mocks.pip,
      sdkContainerPython: mocks.container,
      sdkPythonPackageIndex: mocks.index,
      pypiPackage: mocks.pypi,
      cancelRequest: mocks.cancel,
    },
  };
});

vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ activePath: () => mocks.active, onActiveInputChange: () => () => {} }),
}));

const { useProject } = await import("@/platform/project");
const { PackagesView } = await import("./PackagesView");

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const INSTALLED = [
  { name: "requests", version: "2.31.0" },
  { name: "urllib3", version: "2.8.0" },
];
const SIX = {
  name: "six",
  summary: "Python 2 and 3 compatibility utilities",
  latest: "1.17.0",
  versions: ["1.17.0", "1.16.0"],
};

function open(interpreter = "") {
  useProject.setState({
    project: { root: "/p" } as ProjectInfo,
    settings: { languages: { python: { interpreter } } } as never,
  });
  render(<PackagesView />);
}
// The list selects a row on mouse down.
const select = (row: HTMLElement) => fireEvent.mouseDown(row);
const search = (text: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Search packages" }), { target: { value: text } });

beforeEach(() => {
  mocks.effective.mockResolvedValue(ok("/p/.venv/bin/python"));
  mocks.packages.mockImplementation((_python: string, outdated: boolean) =>
    Promise.resolve(ok(outdated ? [{ name: "requests", version: "2.31.0", latestVersion: "2.34.2" }] : INSTALLED)),
  );
  mocks.pypi.mockImplementation((name: string) => Promise.resolve(ok(name === "six" ? SIX : null)));
  mocks.pip.mockResolvedValue(ok(null));
  mocks.container.mockResolvedValue(ok(null));
  mocks.index.mockResolvedValue(ok(null));
  mocks.active = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Python Packages", () => {
  it("lists the interpreter's packages and marks the upgradable ones", async () => {
    open();
    expect(await screen.findByText("urllib3")).toBeInTheDocument();
    expect(await screen.findByTitle("Upgrade available: 2.34.2")).toBeInTheDocument();
    expect(mocks.packages).toHaveBeenCalledWith("/p/.venv/bin/python", false, expect.anything());
    expect(mocks.pypi).not.toHaveBeenCalled();
  });

  it("finds a PyPI project by its exact name and installs it", async () => {
    open();
    await screen.findByText("urllib3");
    search("six");
    select(await screen.findByText("six"));
    expect(screen.queryByText("urllib3")).toBeNull();
    expect(await screen.findByText(SIX.summary)).toBeInTheDocument();
    expect(mocks.pypi).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    // No version picked: pip chooses the newest one the interpreter can install.
    expect(mocks.pip).toHaveBeenCalledWith(
      "/p/.venv/bin/python",
      "six",
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
    // The list is read again once pip is done.
    await waitFor(() => expect(mocks.packages.mock.calls.filter((c) => c[1] === false)).toHaveLength(2));
  });

  it("sends an installed package's name to PyPI only when asked, once per session", async () => {
    open();
    select(await screen.findByText("urllib3"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mocks.pypi).not.toHaveBeenCalled();
    mocks.pypi.mockResolvedValue(ok({ ...SIX, name: "urllib3", summary: "HTTP library" }));
    fireEvent.click(screen.getByRole("button", { name: "Show PyPI Details" }));
    expect(await screen.findByText("HTTP library")).toBeInTheDocument();
    select(screen.getByText("requests"));
    select(screen.getByText("urllib3"));
    expect(screen.getByText("HTTP library")).toBeInTheDocument();
    expect(mocks.pypi).toHaveBeenCalledTimes(1);
  });

  it("does not search PyPI on its own when installing uses another index", async () => {
    mocks.index.mockResolvedValue(ok("https://pypi.acme.dev/simple"));
    open();
    await screen.findByText("urllib3");
    search("acme-utils");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.pypi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search PyPI for acme-utils" }));
    await waitFor(() => expect(mocks.pypi).toHaveBeenCalledWith("acme-utils", expect.anything()));
  });

  it("says when PyPI cannot be reached, and tries again", async () => {
    mocks.pypi.mockResolvedValue({ status: "error", error: { kind: "unavailable", message: "offline" } });
    open();
    await screen.findByText("urllib3");
    search("flask");
    expect(await screen.findByText("Could not load package information from PyPI.")).toBeInTheDocument();
    expect(screen.queryByText("No packages match")).not.toBeInTheDocument();
    mocks.pypi.mockResolvedValue(ok({ ...SIX, name: "flask" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("flask")).toBeInTheDocument();
  });

  it("manages the interpreter of the active file's folder, and shows it", async () => {
    mocks.active = "/p/backend/app.py";
    mocks.effective.mockResolvedValue(ok("/p/backend/.venv/bin/python"));
    open();
    expect(await screen.findByText("backend/.venv/bin/python")).toBeInTheDocument();
    expect(mocks.effective).toHaveBeenCalledWith("/p/backend");
  });

  it("reloads the list after a failed pip run, which may have installed part of it", async () => {
    mocks.pip.mockResolvedValue({ status: "error", error: { kind: "io", message: "pip failed" } });
    open();
    select(await screen.findByText("requests"));
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall" }));
    expect(await screen.findByText("pip failed")).toBeInTheDocument();
    await waitFor(() => expect(mocks.packages.mock.calls.filter((c) => c[1] === false)).toHaveLength(2));
  });

  it("does not ask PyPI about text that is not a package name", async () => {
    open();
    await screen.findByText("urllib3");
    search("requests==2");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.pypi).not.toHaveBeenCalled();
    expect(screen.getByText("No packages match")).toBeInTheDocument();
  });

  it("upgrades and uninstalls an installed package", async () => {
    open();
    select(await screen.findByText("requests"));
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to 2.34.2" }));
    expect(mocks.pip).toHaveBeenLastCalledWith(
      "/p/.venv/bin/python",
      "requests",
      false,
      true,
      expect.anything(),
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Uninstall" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    expect(mocks.pip).toHaveBeenLastCalledWith(
      "/p/.venv/bin/python",
      "requests",
      true,
      false,
      expect.anything(),
      expect.anything(),
    );
  });

  it("says so when the project has no interpreter", async () => {
    mocks.effective.mockResolvedValue(ok(null));
    open();
    expect(await screen.findByText("No Python interpreter")).toBeInTheDocument();
    expect(mocks.packages).not.toHaveBeenCalled();
  });

  it("refreshes a container snapshot that is still being taken", async () => {
    mocks.container
      .mockResolvedValueOnce(ok({ packages: [], updating: true }))
      .mockResolvedValue(ok({ packages: [{ name: "Django", version: "5.1.3" }], updating: false }));
    open("target:web");
    expect(await screen.findByText("Loading packages…")).toBeInTheDocument();
    expect(await screen.findByText("Django", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(mocks.container).toHaveBeenCalledTimes(2);
  });

  it("lists a container interpreter's packages read-only", async () => {
    mocks.container.mockResolvedValue(ok({ packages: [{ name: "Django", version: "5.1.3" }] }));
    open("target:web");
    select(await screen.findByText("Django"));
    expect(screen.getByText(/read-only here/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull();
    search("six");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.pypi).not.toHaveBeenCalled();
    expect(mocks.packages).not.toHaveBeenCalled();
  });
});
