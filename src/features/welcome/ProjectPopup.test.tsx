import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import type { OpenProject, RecentProject, RecentProjectGroup } from "@/platform/ipc";
import { remoteLocation } from "@/platform/remote";

const wsl = { kind: "wsl", distro: "Ubuntu-24.04" } as const;
let open: OpenProject[] = [];
let recent: RecentProject[] = [];
let groups: RecentProjectGroup[] = [];

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      recentProjects: async () => recent,
      recentProjectGroups: async () => groups,
      windowOpenProjects: async () => ({ status: "ok", data: open }),
    },
  };
});
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));

import { ProjectPopup } from "./ProjectPopup";

describe("ProjectPopup", () => {
  it("lists remote windows under Open Projects, not again under Recent Projects", async () => {
    open = [
      { name: "FastAPIProject", root: "/root/projetos/FastAPIProject", current: true, remote: wsl },
      { name: "datahub-front", root: "/root/projetos/datahub-front", current: false, remote: wsl },
    ];
    recent = [
      {
        path: remoteLocation(wsl, "/root/projetos/FastAPIProject"),
        name: "FastAPIProject",
        openedAtMs: 2,
        branch: null,
      },
      { path: remoteLocation(wsl, "/root/projetos/datahub-front"), name: "datahub-front", openedAtMs: 1, branch: null },
      { path: remoteLocation(wsl, "/root/projetos/other"), name: "other", openedAtMs: 0, branch: null },
    ];
    const anchor = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchor} />
        <ProjectPopup anchor={anchor} onClose={() => {}} />
      </>,
    );
    await screen.findByText("Open Projects");
    const list = screen.getByRole("listbox");
    const text = list.textContent ?? "";
    expect(text.indexOf("Open Projects")).toBeLessThan(text.indexOf("FastAPIProject"));
    expect(text.indexOf("datahub-front")).toBeLessThan(text.indexOf("Recent Projects"));
    expect(text.indexOf("Recent Projects")).toBeLessThan(text.indexOf("other"));
    expect(within(list).getAllByText("FastAPIProject")).toHaveLength(1);
  });

  it("lists recent projects under the Welcome screen's groups, collapsed or not, then the ungrouped ones", async () => {
    open = [{ name: "current", root: "/w/current", current: true, remote: null }];
    const project = (name: string, at: number): RecentProject => ({
      path: `/w/${name}`,
      name,
      openedAtMs: at,
      branch: null,
    });
    recent = [project("current", 9), project("example-web", 5), project("loose", 4), project("example-api", 3)];
    groups = [
      { name: "Frontend", paths: ["/w/example-web"], expanded: true },
      { name: "Backend", paths: ["/w/example-api", "/w/current"], expanded: false },
    ];
    const anchor = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchor} />
        <ProjectPopup anchor={anchor} onClose={() => {}} />
      </>,
    );
    await screen.findByText("Frontend");
    const text = screen.getByRole("listbox").textContent ?? "";
    const order = ["Recent Projects", "Frontend", "example-web", "Backend", "example-api", "loose"];
    expect(order.map((t) => text.indexOf(t))).toEqual([...order.map((t) => text.indexOf(t))].sort((a, b) => a - b));
    expect(order.every((t) => text.includes(t))).toBe(true);
    // The open project stays under Open Projects only.
    expect(within(screen.getByRole("listbox")).getAllByText("current")).toHaveLength(1);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).not.toContain("Frontend");
  });
});
