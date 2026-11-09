import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SyncEntry } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";

const mocks = vi.hoisted(() => ({ equal: vi.fn(), sync: vi.fn(), refresh: vi.fn() }));
vi.mock("./comparison", () => ({ createDeploymentComparison: () => ({ equal: mocks.equal, preview: vi.fn() }) }));
vi.mock("./SyncPreview", () => ({
  SyncPreview: ({ entry }: { entry: SyncEntry | null }) => <div data-testid="preview">{entry?.remotePath}</div>,
}));
vi.mock("./actions", () => ({ closeSync: vi.fn(), runSync: mocks.sync, openSync: mocks.refresh }));
import { DeploymentDialogs } from "./Dialogs";
import { initialSyncChoices } from "./model";
import { useDeployment } from "./store";
import { SyncDialog } from "./SyncDialog";

const entry = (path: string, status: SyncEntry["status"]): SyncEntry => ({
  path,
  remotePath: `/srv/app/${path}`,
  local: status === "remoteOnly" ? null : { size: 2048, mtime: 1_700_000_000 },
  remote: status === "localOnly" ? null : { size: 2048, mtime: 1_700_000_100 },
  status,
});
function openSync(entries: SyncEntry[]) {
  useDeployment.setState({
    sync: {
      server: "s1",
      serverName: "Staging",
      paths: ["/work/app"],
      skipped: [],
      request: null,
      entries,
      error: null,
      choices: initialSyncChoices(entries),
      hideSame: true,
      running: false,
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.equal.mockResolvedValue(false);
  useProject.setState({
    project: { root: "/work/app" } as never,
    settings: {
      deployment: { servers: [{ ...DEFAULT_DEPLOYMENT_SERVER, id: "s1", name: "Staging" }] },
    } as never,
  });
});
afterEach(() => {
  cleanup();
  useDeployment.setState({ sync: null });
});
const table = () => screen.getByRole("grid", { name: "Files to synchronize" });
const row = (path: string) =>
  within(table())
    .getByRole("combobox", { name: `Action ${path}` })
    .closest("tr")!;

describe("deployment directory and content comparison", () => {
  it("fills a secondary window without creating an in-page modal and saves local edits before synchronization", async () => {
    let saved!: () => void;
    const beforeSynchronize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    openSync([entry("a.php", "localOnly")]);
    render(<SyncDialog standalone beforeSynchronize={beforeSynchronize} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Diff Between 'local files' and 'files on Staging'" })).toContainElement(
      table(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Synchronize All" }));
    expect(screen.getByRole("button", { name: "Synchronize All" })).toBeDisabled();
    expect(mocks.sync).not.toHaveBeenCalled();
    await act(async () => saved());
    expect(mocks.sync).toHaveBeenCalledWith([{ path: "a.php", action: "upload" }]);
  });
  it("shows mirrored metadata and previews the selected file, with identical rows filtered", () => {
    openSync([entry("a.php", "localOnly"), entry("b.php", "remoteNewer"), entry("c.php", "same")]);
    render(<DeploymentDialogs />);
    expect(within(table()).getByRole("columnheader", { name: "Local name" })).toBeInTheDocument();
    expect(within(table()).getByRole("columnheader", { name: "Remote name" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Action c.php" })).not.toBeInTheDocument();
    expect(screen.getByTestId("preview")).toHaveTextContent("/srv/app/a.php");
    fireEvent.click(row("b.php"));
    expect(row("b.php")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("preview")).toHaveTextContent("/srv/app/b.php");
    fireEvent.click(screen.getByRole("button", { name: "Show identical files" }));
    expect(screen.getByRole("combobox", { name: "Action c.php" })).toHaveValue("skip");
  });
  it("filters by name and category, navigates with arrows and cycles operations with Space", () => {
    openSync([entry("a.php", "localOnly"), entry("b.php", "remoteNewer")]);
    render(<DeploymentDialogs />);
    fireEvent.keyDown(table(), { key: "ArrowDown" });
    expect(row("b.php")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(table(), { key: " " });
    expect(screen.getByRole("combobox", { name: "Action b.php" })).toHaveValue("deleteRemote");
    fireEvent.keyDown(screen.getByLabelText("Filter by name"), { key: "Enter" });
    expect(mocks.sync).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Filter by name"), { target: { value: "b.php" } });
    expect(screen.queryByRole("combobox", { name: "Action a.php" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show different files" }));
    expect(screen.getByText("No matching differences")).toBeInTheDocument();
  });
  it("updates a row's operation and only applies explicit synchronization", () => {
    openSync([entry("a.php", "localOnly")]);
    render(<DeploymentDialogs />);
    fireEvent.change(screen.getByLabelText("Action a.php"), { target: { value: "skip" } });
    expect(screen.getByRole("button", { name: "Synchronize All" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Action a.php"), { target: { value: "upload" } });
    fireEvent.click(screen.getByRole("button", { name: "Synchronize All" }));
    expect(mocks.sync).toHaveBeenCalledWith([{ path: "a.php", action: "upload" }]);
  });
  it("finds content hidden by identical metadata and skips byte-identical files", async () => {
    mocks.equal.mockImplementation(async (e: SyncEntry) => e.path === "a.php");
    openSync([entry("a.php", "localNewer"), entry("b.php", "same")]);
    render(<DeploymentDialogs />);
    fireEvent.change(screen.getByLabelText("Compare by"), { target: { value: "content" } });
    await waitFor(() => expect(screen.getByLabelText("Action b.php")).toHaveValue("upload"));
    expect(screen.queryByLabelText("Action a.php")).not.toBeInTheDocument();
    expect(useDeployment.getState().sync?.choices["a.php"]).toBe("skip");
    expect(mocks.equal).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText("Compare by"), { target: { value: "metadata" } });
    expect(screen.getByLabelText("Action a.php")).toHaveValue("upload");
  });
  it("synchronizes only the current row from the toolbar or Enter, and disables skipped selections", async () => {
    openSync([entry("a.php", "localOnly"), entry("b.php", "remoteNewer")]);
    render(<DeploymentDialogs />);
    fireEvent.click(row("b.php"));
    fireEvent.click(screen.getByRole("button", { name: "Synchronize Selected" }));
    expect(mocks.sync).toHaveBeenCalledWith([{ path: "b.php", action: "download" }], "selected");
    await act(async () => {});
    mocks.sync.mockClear();
    fireEvent.click(row("a.php"));
    fireEvent.keyDown(table(), { key: "Enter" });
    expect(mocks.sync).toHaveBeenCalledWith([{ path: "a.php", action: "upload" }], "selected");
    await act(async () => {});
    mocks.sync.mockClear();
    fireEvent.change(screen.getByLabelText("Action a.php"), { target: { value: "skip" } });
    expect(screen.getByRole("button", { name: "Synchronize Selected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Synchronize All" })).toBeEnabled();
    fireEvent.keyDown(table(), { key: "Enter" });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("preserves manual choices, reports failures, and ignores a cancelled scan", async () => {
    let finish!: (value: boolean) => void;
    mocks.equal.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    openSync([entry("a.php", "localNewer")]);
    render(<DeploymentDialogs />);
    fireEvent.change(screen.getByLabelText("Action a.php"), { target: { value: "skip" } });
    fireEvent.change(screen.getByLabelText("Compare by"), { target: { value: "content" } });
    await waitFor(() => expect(mocks.equal).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Stop content comparison" }));
    await act(async () => finish(true));
    expect(screen.getByLabelText("Action a.php")).toHaveValue("skip");
    mocks.equal.mockRejectedValueOnce(new Error("Permission denied"));
    fireEvent.change(screen.getByLabelText("Compare by"), { target: { value: "content" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByLabelText("Action a.php")).toHaveValue("skip");
  });
});
