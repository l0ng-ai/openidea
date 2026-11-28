import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage?: (e: unknown) => void;
  },
}));

import type { AgentLoginEvent, GhProjectAccountStatus } from "@/bindings";
import * as ipc from "@/platform/ipc";
import { provideEmbeddedTerminal, useSettingsPages } from "@/workbench/contributions";
import { useGhProjectAccount } from "./data/account";
import { activateSettingsPages } from "./settingsPages";
import { GithubSettingsPage } from "./diff/GithubSettingsPage";
import { setReviewDiffSettings, useReviewDiffSettings } from "./diff/settings";

const KEY = "openidea.github.reviewDiff.v1";

beforeEach(() => {
  localStorage.removeItem(KEY);
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  useGhProjectAccount.setState({ status: null, loading: false, saving: false, revision: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  provideEmbeddedTerminal(undefined);
  useGhProjectAccount.setState({ status: null, loading: false, saving: false, revision: 0 });
});

describe("GitHub settings pages", () => {
  it("registers independently of the pull request runtime", () => {
    const dispose = activateSettingsPages();
    expect(useSettingsPages.getState().pages.get("vcs.github")).toMatchObject({ title: "GitHub" });
    expect(useSettingsPages.getState().pages.get("vcs.github")?.component).toBeDefined();
    dispose();
    expect(useSettingsPages.getState().pages.has("vcs.github")).toBe(false);
  });

  it("updates an open page when another window saves or clears review settings", () => {
    render(<GithubSettingsPage />);
    const checkbox = screen.getByRole("checkbox", { name: "Automatically mark opened files as viewed" });
    expect(checkbox).not.toBeChecked();
    act(() => {
      localStorage.setItem(KEY, JSON.stringify({ autoMarkViewed: true, threadsView: "all" }));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    expect(checkbox).toBeChecked();
    expect(useReviewDiffSettings.getState().threadsView).toBe("all");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ autoMarkViewed: true });
  });

  it("ignores unrelated storage changes and recovers from invalid saved settings", () => {
    setReviewDiffSettings({ autoMarkViewed: true });
    localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(useReviewDiffSettings.getState().autoMarkViewed).toBe(true);
    localStorage.setItem(KEY, "invalid JSON");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(useReviewDiffSettings.getState().autoMarkViewed).toBe(false);
  });

  it("suggests a matching non-active GitHub account and shows the GH_TOKEN scope note once chosen", () => {
    useGhProjectAccount.setState({
      status: {
        ghInstalled: true,
        accounts: [
          { login: "alice", active: true },
          { login: "alice-work", active: false },
        ],
        configuredAccount: "",
        effectiveAccount: "alice",
        suggestedAccount: "alice-work",
      },
    });
    render(<GithubSettingsPage />);
    const select = screen.getByRole("button", { name: "GitHub account" });
    expect(select).toHaveTextContent("Automatic (alice)");
    expect(
      screen.getByText("Uses GitHub CLI's active account without setting GH_TOKEN in the project environment."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use alice-work for this project" }));
    expect(screen.getByRole("button", { name: "GitHub account" })).toHaveTextContent("alice-work");
    expect(useGhProjectAccount.getState().status?.configuredAccount).toBe("alice-work");
    expect(
      screen.getByText(
        "Passes this account's GH_TOKEN to processes started in this project (terminals, agents, Git, and run configurations).",
      ),
    ).toBeInTheDocument();
  });

  it("runs in-IDE GitHub CLI sign-in from Add account… and selects the newly added account", async () => {
    provideEmbeddedTerminal(async () => ({
      write: () => {},
      clear: () => {},
      focus: () => {},
      fit: () => {},
      dispose: () => {},
    }));
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    let accounts = [{ login: "alice", active: true }];
    let configuredAccount = "";
    const makeStatus = (): GhProjectAccountStatus => ({
      ghInstalled: true,
      accounts,
      configuredAccount,
      effectiveAccount: configuredAccount || accounts.find((a) => a.active)?.login || null,
      suggestedAccount: null,
    });
    vi.spyOn(ipc.commands, "ghProjectAccountStatus").mockImplementation(async () => ({
      status: "ok",
      data: makeStatus(),
    }));
    const setAccountSpy = vi.spyOn(ipc.commands, "ghSetProjectAccount").mockImplementation(async (account: string) => {
      configuredAccount = account;
      return { status: "ok", data: makeStatus() };
    });
    vi.spyOn(ipc.commands, "termResize").mockResolvedValue({ status: "ok", data: null } as never);
    vi.spyOn(ipc.commands, "termKill").mockResolvedValue({ status: "ok", data: null } as never);
    let sendEvent: ((e: AgentLoginEvent) => void) | null = null;
    const spawnSpy = vi.spyOn(ipc.commands, "agentGhLoginSpawn").mockImplementation(async (_cols, _rows, ch) => {
      sendEvent = (event) => ch.onmessage?.(event);
      return { status: "ok", data: { id: 11, pid: 222, title: "gh" } };
    });

    render(<GithubSettingsPage />);
    const addBtn = await screen.findByRole("button", { name: "Add account…" });
    fireEvent.click(addBtn);

    expect(await screen.findByRole("dialog", { name: "Sign In to GitHub CLI" })).toBeInTheDocument();
    await waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1));

    act(() => {
      sendEvent?.({
        type: "output",
        data: "! First copy your one-time code: AB12-CD34\r\nPress Enter to open https://github.com/login/device in your browser...",
      });
    });
    expect(await screen.findByText("AB12-CD34")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Code & Open Browser" })).toBeInTheDocument();

    act(() => {
      accounts = [
        { login: "alice", active: true },
        { login: "alice-work", active: false },
      ];
      sendEvent?.({ type: "exited", code: 0 });
    });

    await waitFor(() => expect(setAccountSpy).toHaveBeenCalledWith("alice-work"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sign In to GitHub CLI" })).toBeNull());
    expect(screen.getByRole("button", { name: "GitHub account" })).toHaveTextContent("alice-work");
  });

  it("shows primary Sign In… when gh is installed without accounts, and Install GitHub CLI when missing", async () => {
    useGhProjectAccount.setState({
      status: {
        ghInstalled: true,
        accounts: [],
        configuredAccount: "",
        effectiveAccount: null,
        suggestedAccount: null,
      },
    });
    const { rerender } = render(<GithubSettingsPage />);
    expect(screen.getByRole("button", { name: "Sign In…" })).toBeInTheDocument();

    useGhProjectAccount.setState({
      status: {
        ghInstalled: false,
        accounts: [],
        configuredAccount: "",
        effectiveAccount: null,
        suggestedAccount: null,
      },
    });
    rerender(<GithubSettingsPage />);
    expect(screen.getByRole("button", { name: "Install GitHub CLI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download manually…" })).toBeInTheDocument();
  });
});
