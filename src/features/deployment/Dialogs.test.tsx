import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SyncEntry } from "@/platform/ipc";
import { DeploymentDialogs } from "./Dialogs";
import { initialSyncChoices } from "./model";
import { useDeployment } from "./store";

const entry = (path: string, status: SyncEntry["status"]): SyncEntry => ({
  path,
  remotePath: `/srv/app/${path}`,
  local: status === "remoteOnly" ? null : { size: 2048, mtime: 1_700_000_000 },
  remote: status === "localOnly" ? null : { size: 10, mtime: 1_700_000_100 },
  status,
});

function openSync(entries: SyncEntry[]) {
  useDeployment.setState({
    sync: {
      server: "s1",
      serverName: "Staging",
      path: "/work/app",
      request: null,
      entries,
      error: null,
      choices: initialSyncChoices(entries),
      hideSame: true,
      running: false,
    },
  });
}

afterEach(() => {
  cleanup();
  useDeployment.setState({ sync: null });
});

describe("Sync dialog", () => {
  it("lists the differing files with their default actions and hides identical ones", () => {
    openSync([entry("a.php", "localOnly"), entry("b.php", "remoteNewer"), entry("c.php", "same")]);
    render(<DeploymentDialogs />);
    expect(screen.getByText("a.php")).toBeTruthy();
    expect(screen.queryByText("c.php")).toBeNull();
    expect((screen.getByLabelText("Action a.php") as HTMLSelectElement).value).toBe("upload");
    expect((screen.getByLabelText("Action b.php") as HTMLSelectElement).value).toBe("download");

    fireEvent.click(screen.getByLabelText(/Hide identical files/));
    expect(screen.getByText("c.php")).toBeTruthy();
    expect((screen.getByLabelText("Action c.php") as HTMLSelectElement).value).toBe("skip");
  });

  it("updates the choice of a row", () => {
    openSync([entry("a.php", "localOnly")]);
    render(<DeploymentDialogs />);
    fireEvent.change(screen.getByLabelText("Action a.php"), { target: { value: "skip" } });
    expect(useDeployment.getState().sync?.choices["a.php"]).toBe("skip");
    expect((screen.getByRole("button", { name: "Synchronize" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
