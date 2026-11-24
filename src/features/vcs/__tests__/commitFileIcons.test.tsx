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
    });
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
});
