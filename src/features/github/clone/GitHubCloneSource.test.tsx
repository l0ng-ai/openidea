import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ghAccountRepos = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: { ghAccountRepos: () => ghAccountRepos() },
}));

import type { GhAccountRepo } from "@/bindings";
import { GitHubCloneSource, matchRepos } from "./GitHubCloneSource";

const repo = (nameWithOwner: string, extra: Partial<GhAccountRepo> = {}): GhAccountRepo => ({
  nameWithOwner,
  description: null,
  private: false,
  fork: false,
  archived: false,
  cloneUrl: `https://github.com/${nameWithOwner}.git`,
  ...extra,
});
const repos = [repo("me/app", { private: true, description: "The app" }), repo("org/lib", { fork: true })];

afterEach(() => {
  cleanup();
  ghAccountRepos.mockReset();
});

describe("GitHub clone source", () => {
  it("filters by owner/name", () => {
    expect(matchRepos(repos, "").map((r) => r.repo.nameWithOwner)).toEqual(["me/app", "org/lib"]);
    expect(matchRepos(repos, "olib").map((r) => r.repo.nameWithOwner)).toEqual(["org/lib"]);
  });

  it("lists the account's repositories; a click picks one, Enter and double-click clone it", async () => {
    ghAccountRepos.mockResolvedValue({ status: "ok", data: { kind: "ready", login: "me", repos } });
    const onUrl = vi.fn();
    const onClone = vi.fn();
    const { rerender } = render(<GitHubCloneSource url="" onUrl={onUrl} onClone={onClone} disabled={false} />);
    await screen.findByText("me");
    fireEvent.mouseDown(screen.getByRole("option", { name: /org\/lib/ }));
    fireEvent.click(screen.getByRole("option", { name: /org\/lib/ }));
    expect(onClone).not.toHaveBeenCalled();
    expect(onUrl).toHaveBeenLastCalledWith("https://github.com/org/lib.git");
    rerender(
      <GitHubCloneSource url="https://github.com/org/lib.git" onUrl={onUrl} onClone={onClone} disabled={false} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search repositories" }), { key: "ArrowUp" });
    expect(onUrl).toHaveBeenLastCalledWith("https://github.com/me/app.git");
    fireEvent.doubleClick(screen.getByText("me/app"));
    expect(onClone).toHaveBeenCalledWith("https://github.com/me/app.git");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search repositories" }), { key: "Enter" });
    expect(onClone).toHaveBeenLastCalledWith("https://github.com/org/lib.git");
    fireEvent.change(screen.getByRole("textbox", { name: "Search repositories" }), { target: { value: "zzz" } });
    expect(screen.getByText("No matching repositories")).toBeInTheDocument();
  });

  it("says how to sign in when gh is not logged in, and retries", async () => {
    ghAccountRepos.mockResolvedValueOnce({ status: "ok", data: { kind: "notLoggedIn", message: "x" } });
    render(<GitHubCloneSource url="" onUrl={() => {}} onClone={() => {}} disabled={false} />);
    expect(await screen.findByText("Not logged in to GitHub")).toBeInTheDocument();
    ghAccountRepos.mockResolvedValueOnce({ status: "ok", data: { kind: "ready", login: "me", repos } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /me\/app/ })).toBeInTheDocument());
  });
});
