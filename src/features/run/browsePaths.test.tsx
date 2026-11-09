import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const open = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
}));

import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { ConfigForm } from "./ConfigForm";
import { tomcatType } from "./tomcat";
import { newConfigOfType } from "./types";

const config: RunConfig = {
  id: "app",
  name: "app",
  kind: "shell",
  command: "python3",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  envFiles: [".env"],
};

afterEach(cleanup);

describe("Environment variables", () => {
  it("adds the .env files chosen in the file dialog, relative to the project root", async () => {
    useProject.setState({ project: { root: "/work/app" } as never });
    open.mockResolvedValue(["/work/app/.env", "/work/app/config/dev.env", "/elsewhere/shared.env"]);
    const onChange = vi.fn();
    render(<ConfigForm config={config} all={[]} type={undefined} errors={{}} onChange={onChange} modifyRequest={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse for .env Files" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ envFiles: [".env", "config/dev.env", "/elsewhere/shared.env"] }),
      ),
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, defaultPath: "/work/app" }));
  });
});

describe("path fields", () => {
  it("pick the working directory relative to the project root", async () => {
    useProject.setState({ project: { root: "/work/app" } as never });
    open.mockResolvedValue("/work/app/server");
    const onChange = vi.fn();
    render(<ConfigForm config={config} all={[]} type={undefined} errors={{}} onChange={onChange} modifyRequest={0} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Browse…" })[0]!);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cwd: "server" })));
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ directory: true, multiple: false }));
  });

  it("pick a file or a directory for a configuration type's path fields", async () => {
    useProject.setState({ project: { root: "/work/app" } as never });
    const tomcat = { ...newConfigOfType(tomcatType, []), kind: "tomcat-fields", params: { deployment: "war" } };
    const onChange = vi.fn();
    render(<ConfigForm config={tomcat} all={[]} type={tomcatType} errors={{}} onChange={onChange} modifyRequest={0} />);
    const home = screen.getByRole("textbox", { name: "Tomcat installation directory" });
    open.mockResolvedValue("/opt/tomcat");
    fireEvent.click(home.parentElement!.querySelector("button")!);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ params: expect.objectContaining({ tomcatHome: "/opt/tomcat" }) }),
      ),
    );
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ directory: true }));
    const war = screen.getByRole("textbox", { name: "Deployment path" });
    open.mockResolvedValue("/work/app/build/app.war");
    fireEvent.click(war.parentElement!.querySelector("button")!);
    await waitFor(() => expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ directory: false })));
  });
});
