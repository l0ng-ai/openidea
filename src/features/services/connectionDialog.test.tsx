import { act, cleanup, render, screen } from "@testing-library/react";
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
});
