import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentEntry, AgentTask, PullRequestSummary } from "@/bindings";
import * as ipc from "@/platform/ipc";
import * as openUrlMod from "@/platform/openUrl";
import { SessionAssets, resetSessionAssetsCacheForTests } from "./SessionAssets";
import { clearDismissedAssets, extractSessionAssets, parseRemoteCoordinates } from "./sessionAssetsModel";
import { emptyDraft } from "./composerModel";
import { useAgents } from "./store";

const openFileMock = vi.fn(async () => {});

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({
    openFile: openFileMock,
  }),
}));

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    title: "Benchmark session",
    provider: "copilot",
    model: "gemini-4-carbon",
    status: "ready",
    isolation: "local",
    cwd: "/repo",
    projectRoot: "/repo",
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: 0,
    updatedMs: 0,
    config: [],
    commands: [],
    usage: null,
    queue: [],
    ...overrides,
  };
}

describe("parseRemoteCoordinates", () => {
  it("parses HTTPS, standard SSH, and SSH host aliases for GitHub and GitLab", () => {
    expect(parseRemoteCoordinates("https://github.com/l0ng-ai/openidea.git")).toEqual({
      host: "github.com",
      repo: "l0ng-ai/openidea",
      kind: "github",
    });
    expect(parseRemoteCoordinates("git@github-personal:acme/openidea.git")).toEqual({
      host: "github.com",
      repo: "acme/openidea",
      kind: "github",
    });
    expect(parseRemoteCoordinates("git@gitlab.com:acme/platform/service.git")).toEqual({
      host: "gitlab.com",
      repo: "acme/platform/service",
      kind: "gitlab",
    });
  });
});

describe("extractSessionAssets", () => {
  it("extracts multi-repo PRs, gh pr CLI targets, created issues, referenced issues, websites, and artifact files", () => {
    const entries: AgentEntry[] = [
      {
        type: "user",
        text: "Check https://github.com/github/copilot-cli/issues/4275 and compare with `Storage_Session_Design.docx`.",
        attachments: [],
      },
      {
        type: "tool",
        id: "t-read-boilerplate",
        title: "Read AGENTS.md",
        kind: "read",
        status: "completed",
        locations: ["/repo/AGENTS.md", "/repo/docs/guide.md", "/repo/specs/storage_session_spec.docx"],
        output: null,
        diffs: [],
      },
      {
        type: "tool",
        id: "t-edit-code-and-doc",
        title: "Edit files",
        kind: "edit",
        status: "completed",
        locations: ["/repo/test_benchmark.py", "/repo/storage_session_benchmark.md"],
        output: null,
        diffs: [
          { path: "/repo/test_benchmark.py", added: 24, removed: 0 },
          { path: "/repo/storage_session_benchmark.md", added: 80, removed: 5 },
        ],
      },
      {
        type: "tool",
        id: "t-pr-checks",
        title: "env -u GITHUB_TOKEN gh pr checks 122518",
        kind: "execute",
        status: "completed",
        locations: [],
        output: "build\tpass\t1m12s",
        diffs: [],
      },
      {
        type: "tool",
        id: "t-issue-create",
        title: 'gh issue create -R github/copilot-cli --title "ACP: include model context window limits"',
        kind: "execute",
        status: "completed",
        locations: [],
        output: "https://github.com/github/copilot-cli/issues/5466\n",
        diffs: [],
      },
      {
        type: "agent",
        text: [
          "Results are ready:",
          "- [#118374 feat(storage): support pooled session handles](https://github.com/acme/monorepo/pull/118374)",
          "- [#49270 gateway: add session cache middleware](https://github.com/acme/gateway/pull/49270)",
          "- [a4f91c2 — Add async pool benchmark harness](https://github.com/acme/monorepo/commit/a4f91c2890123456)",
          "- [Discussion #309: Async pool sizing guidelines](https://github.com/acme/monorepo/discussions/309)",
          "- [ENG-204: Harmonize retry budget](https://linear.app/acme/issue/ENG-204/harmonize-retry-budget)",
          "- [ADX Dashboard — Storage Egress, TPS, Cache](https://dataexplorer.azure.com/dashboards/abc)",
          "- [Datadog Dashboard: Storage Session Latency (abc-def-123)](https://app.datadoghq.com/dashboard/abc-def-123)",
          "```xml",
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
          "```",
          "Temp image `/var/folders/yc/abc/T/openidea-copilot/shot.png` should be ignored.",
        ].join("\n"),
      },
    ];

    const result = extractSessionAssets({
      task: { cwd: "/repo", projectRoot: "/repo" },
      entries,
      remoteUrl: "git@github-personal:acme/monorepo.git",
    });

    expect(result.pullRequests.map((p) => [p.idLabel, p.repo, p.title])).toEqual([
      ["#49270", "acme/gateway", "gateway: add session cache middleware"],
      ["#118374", "acme/monorepo", "feat(storage): support pooled session handles"],
      ["#122518", "acme/monorepo", "acme/monorepo"],
    ]);

    expect(result.createdIssues.map((i) => [i.idLabel, i.title])).toEqual([
      ["#5466", "ACP: include model context window limits"],
    ]);

    expect(result.references.map((r) => [r.kind, r.idLabel, r.title])).toEqual([
      ["issue", "ENG-204", "Harmonize retry budget"],
      ["discussion", "#309", "Async pool sizing guidelines"],
      ["commit", "a4f91c2", "Add async pool benchmark harness"],
      ["issue", "#4275", "github/copilot-cli"],
    ]);

    expect(result.artifacts).toEqual([
      {
        key: "web:https://app.datadoghq.com/dashboard/abc-def-123",
        kind: "website",
        title: "Datadog Dashboard: Storage Session Latency (abc-def-123)",
        url: "https://app.datadoghq.com/dashboard/abc-def-123",
      },
      {
        key: "web:https://dataexplorer.azure.com/dashboards/abc",
        kind: "website",
        title: "ADX Dashboard — Storage Egress, TPS, Cache",
        url: "https://dataexplorer.azure.com/dashboards/abc",
      },
      {
        key: "file:/repo/storage_session_benchmark.md",
        kind: "file",
        name: "storage_session_benchmark.md",
        path: "/repo/storage_session_benchmark.md",
        rel: "storage_session_benchmark.md",
        externalBinary: false,
      },
      {
        key: "file:/repo/specs/storage_session_spec.docx",
        kind: "file",
        name: "storage_session_spec.docx",
        path: "/repo/specs/storage_session_spec.docx",
        rel: "specs/storage_session_spec.docx",
        externalBinary: true,
      },
      {
        key: "file:/repo/Storage_Session_Design.docx",
        kind: "file",
        name: "Storage_Session_Design.docx",
        path: "/repo/Storage_Session_Design.docx",
        rel: "Storage_Session_Design.docx",
        externalBinary: true,
      },
    ]);
  });
});

describe("SessionAssets component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionAssetsCacheForTests();
    clearDismissedAssets("task-1");
    useAgents.setState({ composers: new Map([["task-1", emptyDraft()]]) });
    vi.spyOn(openUrlMod, "openExternalUrl").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders PR, created Issue, Reference, and Artifact pills, enriches via ghApi, inserts into composer, and persists dismissals", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const branchSummary: PullRequestSummary = {
      number: 120021,
      title: "telemetry: register storage latency metrics",
      author: "alex",
      state: "merged",
      isDraft: false,
      headRef: "feat/session",
      baseRef: "main",
      createdAt: "2026-11-15T00:00:00Z",
      updatedAt: "2026-11-15T01:00:00Z",
      labels: [],
      reviewDecision: "APPROVED",
      url: "https://github.com/acme/monorepo/pull/120021",
      additions: 10,
      deletions: 2,
    };
    vi.spyOn(ipc, "call").mockImplementation(async (promise) => {
      return promise;
    });
    vi.spyOn(ipc.commands, "vcsRemotes").mockResolvedValue([
      { name: "origin", url: "git@github-personal:acme/monorepo.git" },
    ] as never);
    vi.spyOn(ipc.commands, "ghPrList").mockResolvedValue([branchSummary] as never);
    vi.spyOn(ipc.commands, "ghApi").mockImplementation((_repo, req) => {
      if (req.endpoint === "repos/acme/monorepo/pulls/122518") {
        return Promise.resolve(
          JSON.stringify({
            title: "bench: add multi-host throughput harness",
            state: "open",
            draft: false,
            merged: false,
          }),
        ) as never;
      }
      if (req.endpoint === "repos/github/copilot-cli/issues/4275") {
        return Promise.resolve(
          JSON.stringify({
            title: "ACP: expose contextTier as a session config option",
            state: "open",
          }),
        ) as never;
      }
      return Promise.resolve("{}") as never;
    });

    const entries: AgentEntry[] = [
      {
        type: "user",
        text: "See https://github.com/github/copilot-cli/issues/4275",
        attachments: [],
      },
      {
        type: "tool",
        id: "t1",
        title: "gh pr checks 122518",
        kind: "execute",
        status: "completed",
        locations: [],
        output: "",
        diffs: [],
      },
      {
        type: "tool",
        id: "t2",
        title: 'gh issue create -R github/copilot-cli --title "ACP pricing metadata"',
        kind: "execute",
        status: "completed",
        locations: [],
        output: "https://github.com/github/copilot-cli/issues/5466",
        diffs: [],
      },
      {
        type: "tool",
        id: "t3",
        title: "Create report",
        kind: "edit",
        status: "completed",
        locations: ["/repo/storage_session_report.md"],
        output: null,
        diffs: [{ path: "/repo/storage_session_report.md", added: 42, removed: 0 }],
      },
      {
        type: "agent",
        text: "Dashboard: [Datadog Dashboard: Storage Latency](https://app.datadoghq.com/dashboard/abc-def-123)",
      },
    ];

    const onFocus = vi.fn();
    const { unmount } = render(
      <SessionAssets task={makeTask()} entries={entries} head="feat/session" onFocusComposer={onFocus} />,
    );

    const prPill = await screen.findByRole("button", { name: "2 Pull Requests" });
    expect(prPill).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 Issue" })).toHaveTextContent("#5466");
    expect(screen.getByRole("button", { name: "1 Reference" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 Artifacts" })).toBeInTheDocument();

    // Open Pull Requests popup and verify ghApi-enriched title.
    fireEvent.click(prPill);
    const prDialog = await screen.findByRole("dialog", { name: "Pull Requests" });
    await waitFor(() => {
      expect(within(prDialog).getByText("bench: add multi-host throughput harness")).toBeInTheDocument();
    });
    expect(within(prDialog).getByText("telemetry: register storage latency metrics")).toBeInTheDocument();

    // Click PR row to open externally.
    fireEvent.click(within(prDialog).getByText("bench: add multi-host throughput harness"));
    expect(openUrlMod.openExternalUrl).toHaveBeenCalledWith("https://github.com/acme/monorepo/pull/122518");

    // Open References popup and check enriched issue title.
    fireEvent.click(screen.getByRole("button", { name: "1 Reference" }));
    const refDialog = await screen.findByRole("dialog", { name: "References" });
    await waitFor(() => {
      expect(within(refDialog).getByText("ACP: expose contextTier as a session config option")).toBeInTheDocument();
    });

    // Open Artifacts popup, open Markdown file in editor, add file to composer, then dismiss website.
    fireEvent.click(screen.getByRole("button", { name: "2 Artifacts" }));
    const artDialog = await screen.findByRole("dialog", { name: "Artifacts" });
    expect(within(artDialog).getByText("Websites")).toBeInTheDocument();
    expect(within(artDialog).getByText("Files")).toBeInTheDocument();

    const fileRow = within(artDialog).getByText("storage_session_report.md").closest("div")!;
    fireEvent.click(within(fileRow).getByRole("button", { name: "Add to Message" }));
    expect(useAgents.getState().composers.get("task-1")?.text).toBe("@storage_session_report.md ");
    expect(onFocus).toHaveBeenCalledTimes(1);

    // Reopen Artifacts popup and click the Markdown file row to open in editor.
    fireEvent.click(screen.getByRole("button", { name: "2 Artifacts" }));
    const artDialog2 = await screen.findByRole("dialog", { name: "Artifacts" });
    fireEvent.click(within(artDialog2).getByText("storage_session_report.md"));
    expect(openFileMock).toHaveBeenCalledWith("/repo/storage_session_report.md", { focus: true });

    // Reopen and dismiss the website artifact; count drops to 1 Artifact and persists across remount.
    fireEvent.click(screen.getByRole("button", { name: "2 Artifacts" }));
    const artDialog3 = await screen.findByRole("dialog", { name: "Artifacts" });
    const webRow = within(artDialog3).getByText("Datadog Dashboard: Storage Latency").closest("div")!;
    fireEvent.click(within(webRow).getByRole("button", { name: "Remove" }));

    expect(screen.getByRole("button", { name: "1 Artifact" })).toBeInTheDocument();
    unmount();

    render(<SessionAssets task={makeTask()} entries={entries} head="feat/session" />);
    expect(await screen.findByRole("button", { name: "1 Artifact" })).toBeInTheDocument();
  });
});
