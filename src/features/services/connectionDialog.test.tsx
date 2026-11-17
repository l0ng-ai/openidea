import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { openConnectionDialog, ServicesDialogHost } from "./dialogs";

afterEach(() => {
  cleanup();
  useProject.setState({ settings: null });
});

describe("Docker connection dialog", () => {
  it("offers the SSH configurations of Settings › Tools › SSH Configurations", () => {
    const config = {
      id: "ssh1",
      name: "Build server",
      host: "build-server",
      port: 2222,
      user: "ops",
      auth: "openSsh",
      keyFile: "",
      saveSecret: false,
    };
    useProject.setState({ settings: { ssh: { configs: [config] } } as unknown as Settings });
    render(<ServicesDialogHost />);
    act(() =>
      openConnectionDialog({
        id: "c1",
        name: "Docker",
        endpoint: { kind: "tcp", host: "ssh://ops@build-server:2222", tlsCertDir: null },
      } as never),
    );
    const picker = screen.getByRole("button", { name: /SSH configuration/ });
    expect(picker.textContent).toContain("Build server");
    expect(picker.textContent).not.toContain("missing");
  });

  // #3850: a configuration with a password or key connects through the IDE's SSH client, without a URL.
  it("connects through an SSH configuration with its own credentials", () => {
    const config = {
      id: "ssh2",
      name: "Huawei Cloud",
      host: "10.0.0.5",
      port: null,
      user: "root",
      auth: "password",
      keyFile: "",
      saveSecret: true,
    };
    useProject.setState({ settings: { ssh: { configs: [config] } } as unknown as Settings });
    render(<ServicesDialogHost />);
    act(() => openConnectionDialog({ id: "c2", name: "Docker", endpoint: { kind: "ssh", config: "ssh2" } } as never));
    // The dialog store outlives a test's render: look in the dialog this test opened.
    const dialog = within(screen.getAllByRole("dialog").at(-1)!);
    expect(dialog.getByRole("button", { name: "SSH configuration" }).textContent).toContain("Huawei Cloud");
    expect(dialog.queryByLabelText("Engine API URL:")).toBeNull();
    expect(dialog.getByText("Connects with this SSH configuration and runs docker on its host.")).toBeTruthy();
    expect(dialog.getByRole("button", { name: "OK" })).toHaveProperty("disabled", false);
  });
});
