import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  buildModel: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      buildModel: mocks.buildModel,
    },
  };
});

vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid={`icon-${name}`} className={className} />
  ),
}));

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { useProject } from "@/platform/project";
import { useBuildPresentation } from "@/platform/projectPresentation";
import { useProjectRoots } from "@/platform/projectRoots";
import { useContextMenuStore, type MenuItem } from "@/ui/Menu";
import { ChangesTree } from "../CommitView";
import { resolveChangeModules } from "../changeModules";
import { setGroupByModule, useCommit } from "../commitStore";
import { useVcs } from "../store";

const change = (path: string) => ({
  path,
  relPath: path.split("/").slice(3).join("/"),
  staged: null,
  unstaged: "modified" as const,
  renamedFrom: null,
});

function groupByItems(): Record<string, boolean> {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
  });
  const items = useContextMenuStore.getState().menu!.items as Array<MenuItem & { label?: string; checked?: boolean }>;
  act(() => useContextMenuStore.setState({ menu: null }));
  const end = items.findIndex((i) => i.kind === "separator");
  return Object.fromEntries(
    items
      .slice(0, end < 0 ? undefined : end)
      .filter((i) => i.kind !== "header" && i.label)
      .map((i) => [i.label!, !!i.checked]),
  );
}

function runItem(label: string) {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
  });
  const item = useContextMenuStore.getState().menu!.items.find((i) => "label" in i && i.label === label) as {
    run: () => void;
  };
  act(() => {
    item.run();
    useContextMenuStore.setState({ menu: null });
  });
}

describe("resolveChangeModules", () => {
  it("collects modules from detected roots, attached members, workspace projects, and build models", () => {
    const modules = resolveChangeModules({
      projectRoot: "/w",
      projectName: "workspace",
      workspaceProjects: ["/w/base", "/w/basemdm"],
      detected: [{ path: "src/main/java", kind: "source", detectedFrom: "pom.xml" }],
      attached: [
        {
          root: "/w/basemdm",
          structure: {} as never,
          detected: [{ path: "sub/src/main/java", kind: "source", detectedFrom: "sub/pom.xml" }],
        },
      ],
      build: {
        modules: new Map([
          ["/w/base", "maven"],
          ["/w/basemdm", "maven"],
          ["/w/basemdm/sub", "gradle"],
        ]),
        moduleNames: new Map([
          ["/w/base", "base-core"],
          ["/w/basemdm", "BASEMDM"],
          ["/w/basemdm/sub", "sub-gradle"],
          ["/w/scala", "scala-svc"],
        ]),
        spring: false,
      },
    });
    expect(modules).toEqual([
      { path: "/w", name: "workspace", tool: undefined },
      { path: "/w/base", name: "base-core", tool: "maven" },
      { path: "/w/basemdm", name: "BASEMDM", tool: "maven" },
      { path: "/w/basemdm/sub", name: "sub-gradle", tool: "gradle" },
      { path: "/w/scala", name: "scala-svc", tool: undefined },
    ]);
  });
});

describe("Group By › Module in ChangesTree", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.buildModel.mockReset().mockResolvedValue({
      status: "ok",
      data: {
        maven: {
          projects: [
            {
              dir: "/w/base",
              pom: "/w/base/pom.xml",
              groupId: "com.acme",
              artifactId: "base",
              displayName: "base",
              version: "1.0",
              packaging: "jar",
              parent: null,
              modules: [],
              aggregated: false,
              plugins: [],
              dependencies: [],
              profiles: [],
              javaVersion: 21,
              projectRoot: "/w/base",
            },
            {
              dir: "/w/basemdm",
              pom: "/w/basemdm/pom.xml",
              groupId: "com.acme",
              artifactId: "BASEMDM",
              displayName: "BASEMDM",
              version: "1.0",
              packaging: "jar",
              parent: null,
              modules: [],
              aggregated: false,
              plugins: [],
              dependencies: [],
              profiles: [],
              javaVersion: 21,
              projectRoot: "/w/basemdm",
            },
          ],
          profiles: [],
          syncedAt: null,
          stale: false,
          syncError: null,
        },
        gradle: [],
      },
    });
    useBuildPresentation.setState({ modules: new Map(), moduleNames: new Map(), spring: false });
    useCommit.setState({
      groupByDir: false,
      groupByStaging: false,
      groupByRepo: true,
      groupByModule: false,
      checks: new Map(),
      selection: [],
    });
    useProject.setState({
      project: {
        name: "w",
        root: "/w",
        trusted: true,
        isGit: true,
        settings: {},
        workspace: { version: 1, name: "w", projects: ["/w/base", "/w/basemdm"] },
      } as never,
      settings: {} as never,
    });
    useProjectRoots.setState({ root: "/w", detected: [], attached: [] });
    useVcs.setState({
      root: "/w",
      repo: "/w/base",
      roots: ["/w/base", "/w/basemdm"],
      heads: {
        "/w/base": { head: "main", headCommit: "11111111" },
        "/w/basemdm": { head: "master", headCommit: "22222222" },
      },
      status: [change("/w/base/src/Main.java"), change("/w/basemdm/src/Mdm.java")],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("offers Module in View Options, toggles and persists it, and renders module nodes with module icons", async () => {
    render(<ChangesTree mode="commit" />);
    expect(await screen.findByText("base")).toBeInTheDocument();
    expect(groupByItems()).toEqual({
      Directory: false,
      Repository: true,
      Module: false,
      "Staging State": false,
    });

    runItem("Module");
    expect(useCommit.getState().groupByModule).toBe(true);
    expect(localStorage.getItem("openidea.vcs.groupByModule")).toBe("true");
    expect(groupByItems().Module).toBe(true);

    const mdmModuleLabel = await screen.findByText("BASEMDM");
    const mdmModuleRow = mdmModuleLabel.closest('[role="treeitem"]') as HTMLElement;
    expect(mdmModuleRow.querySelector('[data-testid="icon-module"]')).not.toBeNull();
    expect(mdmModuleRow.textContent).toContain("basemdm");
  });

  it("persists groupByModule across store reloads", async () => {
    setGroupByModule(true);
    vi.resetModules();
    const { useCommit: fresh } = await import("../commitStore");
    expect(fresh.getState().groupByModule).toBe(true);
  });
});
