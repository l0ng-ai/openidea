import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useSettingsPages } from "@/workbench/contributions";
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
});
