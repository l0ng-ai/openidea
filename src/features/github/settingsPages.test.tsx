import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useSettingsPages } from "@/workbench/contributions";
import { activateSettingsPages } from "./settingsPages";
import { GithubSettingsPage } from "./diff/GithubSettingsPage";
import { setReviewDiffSettings, useReviewDiffSettings } from "./diff/settings";

const KEY = "openidea.github.reviewDiff.v1";

beforeEach(() => {
  localStorage.removeItem(KEY);
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
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
});
