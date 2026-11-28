import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/platform/ipc";

const mocks = vi.hoisted(() => ({
  effective: vi.fn(),
  packages: vi.fn(),
  pypi: vi.fn(),
  names: vi.fn(),
  pip: vi.fn(),
  container: vi.fn(),
  index: vi.fn(),
  cancel: vi.fn(),
  menu: vi.fn(),
  openUrl: vi.fn(),
  active: null as string | null,
}));
vi.mock("@/platform/openUrl", () => ({ openExternalUrl: mocks.openUrl }));
// The context menu host is not mounted here: pick menu items by label instead.
vi.mock("@/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui")>()),
  showContextMenu: mocks.menu,
}));
const pick = (label: string) =>
  (mocks.menu.mock.lastCall![1] as { label: string; run: () => void }[]).find((i) => i.label === label)!.run();
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
      pypiSearch: mocks.names,
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
  description: "# Six\n\nRead the [documentation](https://six.readthedocs.io/).<script>alert(1)</script>",
  markdown: true,
  links: [{ label: "Source", url: "https://github.com/benjaminp/six" }],
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
  mocks.names.mockResolvedValue(ok([]));
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
      false,
      expect.anything(),
      expect.anything(),
    );
    // The list is read again once pip is done.
    await waitFor(() => expect(mocks.packages.mock.calls.filter((c) => c[1] === false)).toHaveLength(2));
  });

  it("installs a repository URL or a local directory, in editable mode when asked", async () => {
    open();
    await screen.findByText("urllib3");
    fireEvent.click(screen.getByRole("button", { name: "Install from Version Control or Disk" }));
    act(() => pick("Install from Version Control…"));
    const url = await screen.findByRole("textbox", { name: "Repository URL" });
    // A name is not a repository, and editable is offered only for a local directory.
    fireEvent.change(url, { target: { value: "requests" } });
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: "Install as editable (-e)" })).toBeNull();
    fireEvent.change(url, { target: { value: "https://github.com/benjaminp/six.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(mocks.pip).toHaveBeenLastCalledWith(
      "/p/.venv/bin/python",
      "git+https://github.com/benjaminp/six.git",
      false,
      false,
      false,
      expect.anything(),
      expect.anything(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Install from Version Control or Disk" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Install from Version Control or Disk" }));
    act(() => pick("Install from Disk…"));
    const path = await screen.findByRole("textbox", { name: "Path" });
    fireEvent.change(path, { target: { value: "--index-url=https://evil.example" } });
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    fireEvent.change(path, { target: { value: "dist/mylib-0.1.0-py3-none-any.whl" } });
    expect(screen.getByRole("checkbox", { name: "Install as editable (-e)" })).toBeDisabled();
    // A bare name is a directory here, never a PyPI package.
    fireEvent.change(path, { target: { value: "mylib" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Install as editable (-e)" }));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(mocks.pip).toHaveBeenLastCalledWith(
      "/p/.venv/bin/python",
      "./mylib",
      false,
      false,
      true,
      expect.anything(),
      expect.anything(),
    );
  });

  it("shows a PyPI project's links and its Markdown description, opening links in the browser", async () => {
    open();
    await screen.findByText("urllib3");
    search("six");
    select(await screen.findByText("six"));
    expect(await screen.findByRole("heading", { name: "Six" })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    const links = screen.getByRole("navigation", { name: "Project links" });
    expect([...links.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["PyPI", "Source"]);
    fireEvent.click(screen.getByRole("link", { name: "PyPI" }));
    fireEvent.click(screen.getByRole("link", { name: "documentation" }));
    expect(mocks.openUrl.mock.calls).toEqual([["https://pypi.org/project/six/"], ["https://six.readthedocs.io/"]]);
  });

  it("shows a description that is not Markdown as text", async () => {
    open();
    await screen.findByText("urllib3");
    mocks.pypi.mockResolvedValue(ok({ ...SIX, name: "docutils", description: "Docutils\n========", markdown: false }));
    search("docutils");
    select(await screen.findByText("docutils"));
    expect((await screen.findByLabelText("Package description")).textContent).toBe("Docutils\n========");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("sends an installed package's name to PyPI only when asked, once per session", async () => {
    open();
    select(await screen.findByText("urllib3"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mocks.pypi).not.toHaveBeenCalled();
    mocks.pypi.mockResolvedValue(ok({ ...SIX, name: "urllib3", summary: "HTTP library" }));
    fireEvent.click(screen.getByRole("button", { name: "Show PyPI Details" }));
    expect(await screen.findByText("HTTP library")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PyPI" })).toHaveAttribute("href", "https://pypi.org/project/urllib3/");
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
    // Not even the name search's results, though searching the cached list sends nothing.
    expect(mocks.names).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search PyPI for acme-utils" }));
    await waitFor(() => expect(mocks.pypi).toHaveBeenCalledWith("acme-utils", expect.anything()));
    await waitFor(() => expect(mocks.names).toHaveBeenCalledWith("acme-utils", expect.anything()));
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

  it("lists PyPI projects whose names contain the search text", async () => {
    mocks.names.mockResolvedValue(ok(["six", "sixer", "django-six"]));
    open();
    await screen.findByText("urllib3");
    search("six");
    select(await screen.findByText("sixer"));
    expect(mocks.names).toHaveBeenCalledWith("six", expect.anything());
    expect(screen.getAllByText("six")).toHaveLength(1);
    // The details of a search result come from the exact-name lookup.
    await waitFor(() => expect(mocks.pypi).toHaveBeenCalledWith("sixer", expect.anything()));
  });

  it("lists 50 PyPI matches and says when there are more", async () => {
    mocks.names.mockResolvedValue(ok(Array.from({ length: 51 }, (_, i) => `six-${i}`)));
    open();
    await screen.findByText("urllib3");
    search("six-");
    expect(await screen.findByText(/Only the first 50 PyPI matches are listed/)).toBeInTheDocument();
  });

  it("keeps the exact-name lookup when the name list cannot be loaded", async () => {
    mocks.names.mockResolvedValue({ status: "error", error: { kind: "unavailable", message: "offline" } });
    open();
    await screen.findByText("urllib3");
    search("six");
    expect(await screen.findByText(/Could not load the list of PyPI package names/)).toBeInTheDocument();
    expect(screen.getByText("six")).toBeInTheDocument();
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
      false,
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
    expect(mocks.names).not.toHaveBeenCalled();
    expect(mocks.packages).not.toHaveBeenCalled();
  });
});
