import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Commit, FileStatus } from "@/bindings";

const mocks = vi.hoisted(() => ({
  presentations: vi.fn(),
  buildModel: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      jvmFilePresentations: mocks.presentations,
      buildModel: mocks.buildModel,
    },
  };
});

vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { useProject } from "@/platform/project";
import { useBuildPresentation } from "@/platform/projectPresentation";
import { useProjectRoots } from "@/platform/projectRoots";
import { ChangesTree } from "../CommitView";
import { amendPreviewNode } from "../amendPreview";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

const ROOT = "/p";

const statusFile = (
  relPath: string,
  unstaged: FileStatus["unstaged"] = "modified",
  staged: FileStatus["staged"] = null,
  renamedFrom: string | null = null,
): FileStatus => ({
  path: `${ROOT}/${relPath}`,
  relPath,
  staged,
  unstaged,
  renamedFrom,
});

const headCommit: Commit = {
  id: "head-1",
  shortId: "head-1",
  parents: ["parent-1"],
  author: "Dev",
  email: "dev@example.test",
  committer: "Dev",
  committerEmail: "dev@example.test",
  timeMs: 1_700_000_000_000,
  summary: "Previous commit",
  message: "Previous commit",
  messageTruncated: false,
  refs: [],
  commitTimeMs: 1_700_000_000_000,
};

function iconOf(label: string): string | null {
  return screen.getByText(label).previousElementSibling?.getAttribute("data-testid") ?? null;
}

describe("Commit changes tree file icons", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.presentations.mockReset().mockResolvedValue({ status: "ok", data: [] });
    mocks.buildModel.mockReset().mockResolvedValue({ status: "ok", data: { maven: null, gradle: [] } });
    useProject.setState({
      project: { name: "p", root: ROOT, trusted: true, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    useProjectRoots.setState({
      root: ROOT,
      detected: [
        { path: "src/test/java", kind: "test", detectedFrom: "pom.xml" },
        { path: "src/main/resources", kind: "resources", detectedFrom: "pom.xml" },
      ],
      attached: [],
    });
    useBuildPresentation.setState({ modules: new Map(), spring: false });
    useCommit.setState({
      groupByDir: false,
      groupByStaging: false,
      groupByRepo: false,
      showUnversionedSeparately: true,
    });
    useVcs.setState({
      root: ROOT,
      repo: ROOT,
      roots: [ROOT],
      heads: {},
      status: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows Project-tree declaration and Spring icons in Commit and skips deleted files", async () => {
    useVcs.setState({
      status: [
        statusFile("src/main/java/Order.java"),
        statusFile("src/main/java/PricingRule.java", "renamed", null, "src/main/java/Rule.java"),
        statusFile("src/test/java/OrderTest.java", "added"),
        statusFile("src/main/kotlin/Pricing.kt"),
        statusFile("src/main/resources/application.yml"),
        statusFile("src/main/java/Removed.java", "deleted"),
      ],
    });
    mocks.presentations.mockResolvedValue({
      status: "ok",
      data: [
        {
          path: `${ROOT}/src/main/java/Order.java`,
          presentation: { kind: "class", springBoot: false, runnable: false, deprecated: false },
        },
        {
          path: `${ROOT}/src/main/java/PricingRule.java`,
          presentation: { kind: "interface", springBoot: false, runnable: false, deprecated: false },
        },
        {
          path: `${ROOT}/src/test/java/OrderTest.java`,
          presentation: { kind: "class", springBoot: false, runnable: false, deprecated: false },
        },
        {
          path: `${ROOT}/src/main/kotlin/Pricing.kt`,
          presentation: { kind: "object", springBoot: false, runnable: false, deprecated: false },
        },
      ],
    });

    render(<ChangesTree mode="commit" />);
    expect(await screen.findByTestId("icon-class")).toBeInTheDocument();
    expect(iconOf("Order.java")).toBe("icon-class");
    expect(iconOf("PricingRule.java")).toBe("icon-interface");
    expect(iconOf("OrderTest.java")).toBe("icon-jvm-test");
    expect(iconOf("Pricing.kt")).toBe("icon-kotlin-object");
    expect(iconOf("application.yml")).toBe("icon-spring-config");
    expect(iconOf("Removed.java")).toBe("icon-file-java");
    expect(mocks.presentations.mock.calls.flatMap(([paths]) => paths).sort()).toEqual([
      `${ROOT}/src/main/java/Order.java`,
      `${ROOT}/src/main/java/PricingRule.java`,
      `${ROOT}/src/main/kotlin/Pricing.kt`,
      `${ROOT}/src/test/java/OrderTest.java`,
    ]);
  });

  it("keeps the file-type icon for an added-then-deleted file in staging area mode", async () => {
    useProject.setState({
      project: { name: "p", root: ROOT, trusted: true, isGit: true, settings: {} } as never,
      settings: { vcs: { git: { stagingArea: true }, commit: { nonModal: true } } } as never,
    });
    useVcs.setState({
      status: [
        statusFile("src/main/java/Live.java", null, "modified"),
        statusFile("src/main/java/Gone.java", "deleted", "added"),
      ],
    });
    mocks.presentations.mockResolvedValue({
      status: "ok",
      data: [
        {
          path: `${ROOT}/src/main/java/Live.java`,
          presentation: { kind: "class", springBoot: false, runnable: false, deprecated: false },
        },
      ],
    });

    render(<ChangesTree mode="commit" />);
    expect(await screen.findByTestId("icon-class")).toBeInTheDocument();
    expect(iconOf("Live.java")).toBe("icon-class");
    const goneIcons = screen
      .getAllByText("Gone.java")
      .map((el) => el.previousElementSibling?.getAttribute("data-testid"));
    expect(goneIcons).toEqual(["icon-file-java", "icon-file-java"]);
    expect(mocks.presentations.mock.calls.flatMap(([paths]) => paths)).toEqual([`${ROOT}/src/main/java/Live.java`]);
  });

  it("resolves non-deleted amend preview files and skips deleted amend files", async () => {
    const amended = amendPreviewNode(
      {
        root: ROOT,
        status: "ready",
        head: headCommit,
        expectedHead: headCommit.id,
        differentCommitter: false,
        files: [
          { path: "src/main/java/HeadClass.java", oldPath: null, kind: "modified" },
          { path: "src/main/java/HeadRemoved.java", oldPath: null, kind: "deleted" },
        ],
      },
      false,
      [ROOT],
      headCommit.id,
    );
    mocks.presentations.mockResolvedValue({
      status: "ok",
      data: [
        {
          path: `${ROOT}/src/main/java/HeadClass.java`,
          presentation: { kind: "class", springBoot: false, runnable: false, deprecated: false },
        },
      ],
    });

    render(<ChangesTree mode="commit" amended={amended} />);
    expect(await screen.findByTestId("icon-class")).toBeInTheDocument();
    expect(iconOf("HeadClass.java")).toBe("icon-class");
    expect(iconOf("HeadRemoved.java")).toBe("icon-file-java");
    expect(mocks.presentations.mock.calls.flatMap(([paths]) => paths)).toEqual([
      `${ROOT}/src/main/java/HeadClass.java`,
    ]);
  });

  it("shows Project-tree directory, package, module, and excluded folder icons when grouped by directory", async () => {
    mocks.buildModel.mockResolvedValue({
      status: "ok",
      data: {
        maven: {
          projects: [
            {
              dir: "",
              pom: "pom.xml",
              groupId: "com.acme",
              artifactId: "root",
              displayName: "root",
              version: "1.0",
              packaging: "pom",
              parent: null,
              modules: ["app/pom.xml"],
              aggregated: false,
              plugins: [],
              dependencies: [],
              profiles: [],
              javaVersion: 21,
            },
            {
              dir: "app",
              pom: "app/pom.xml",
              groupId: "com.acme",
              artifactId: "app",
              displayName: "app",
              version: "1.0",
              packaging: "jar",
              parent: null,
              modules: [],
              aggregated: true,
              plugins: [],
              dependencies: [],
              profiles: [],
              javaVersion: 21,
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
    useProjectRoots.setState({
      root: ROOT,
      detected: [
        { path: "app/src/main/java", kind: "source", detectedFrom: "app/pom.xml" },
        { path: "app/src/test/java", kind: "test", detectedFrom: "app/pom.xml" },
        { path: "app/src/main/resources", kind: "resources", detectedFrom: "app/pom.xml" },
        { path: "app/target", kind: "excluded", detectedFrom: "app/pom.xml" },
      ],
      attached: [],
    });
    useCommit.setState({ groupByDir: true, groupByRepo: false });
    useVcs.setState({
      status: [
        statusFile("app/src/main/java/App.java"),
        statusFile("app/src/main/java/com/acme/Order.java"),
        statusFile("app/src/main/java/com/other/Helper.java"),
        statusFile("app/src/test/java/OrderTest.java"),
        statusFile("app/src/main/resources/application.yml"),
        statusFile("app/target/gen.txt"),
        statusFile(".github/CODEOWNERS"),
        statusFile(".github/workflows/ci.yml"),
      ],
    });

    render(<ChangesTree mode="commit" />);
    expect(await screen.findByTestId("icon-maven-module")).toBeInTheDocument();
    expect(iconOf("app")).toBe("icon-maven-module");
    expect(iconOf("java")).toBe("icon-folder-source");
    expect(iconOf("com")).toBe("icon-package");
    expect(iconOf("acme")).toBe("icon-package");
    expect(iconOf("test/java")).toBe("icon-folder-test");
    expect(iconOf("resources")).toBe("icon-folder-resources");
    expect(iconOf("target")).toBe("icon-folder-excluded");
    expect(iconOf(".github")).toBe("icon-folder-github");
  });

  it("resolves test and Spring icons for attached workspace members", async () => {
    const memberRoot = "/workspace/member-b";
    useProject.setState({
      project: {
        name: "Workspace",
        root: "/workspace",
        trusted: true,
        isGit: true,
        settings: {},
        workspace: { version: 1, name: "Workspace", projects: ["/workspace/member-a", memberRoot] },
      } as never,
      settings: {} as never,
    });
    useProjectRoots.setState({
      root: "/workspace",
      detected: [],
      attached: [
        {
          root: memberRoot,
          structure: {
            sourceRoots: [],
            testRoots: [],
            resourceRoots: [],
            testResourceRoots: [],
            excluded: [],
            unmarked: [],
            contentRoots: [],
            dependencies: [],
            memberDependencies: {},
            excludeFiles: "",
            compilerOutput: "",
            modules: {},
            libraries: [],
            facets: [],
            artifacts: [],
          },
          detected: [
            { path: "src/test/java", kind: "test", detectedFrom: "pom.xml" },
            { path: "src/main/resources", kind: "resources", detectedFrom: "pom.xml" },
          ],
        },
      ],
    });
    useCommit.setState({ groupByDir: false, groupByRepo: false });
    useVcs.setState({
      root: "/workspace",
      repo: memberRoot,
      roots: [memberRoot],
      status: [
        {
          path: `${memberRoot}/src/test/java/CustomSpec.java`,
          relPath: "src/test/java/CustomSpec.java",
          staged: null,
          unstaged: "modified",
          renamedFrom: null,
        },
        {
          path: `${memberRoot}/src/main/resources/application.yml`,
          relPath: "src/main/resources/application.yml",
          staged: null,
          unstaged: "modified",
          renamedFrom: null,
        },
      ],
    });
    mocks.presentations.mockResolvedValue({
      status: "ok",
      data: [
        {
          path: `${memberRoot}/src/test/java/CustomSpec.java`,
          presentation: { kind: "class", springBoot: false, runnable: false, deprecated: false },
        },
      ],
    });

    render(<ChangesTree mode="commit" />);
    expect(await screen.findByTestId("icon-jvm-test")).toBeInTheDocument();
    expect(iconOf("CustomSpec.java")).toBe("icon-jvm-test");
    expect(iconOf("application.yml")).toBe("icon-spring-config");
  });
});
