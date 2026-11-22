import { afterEach, expect, it, vi } from "vitest";
import { useWorktreeReviewProvider } from "@/workbench/contributions";
import { useGhRepository, type GHConnection } from "./data/repository";
import { activateWorktreeReviews } from "./worktreeReviews";

const mocks = vi.hoisted(() => ({
  remotes: vi.fn(),
  config: vi.fn(),
  rest: vi.fn(),
  openPullRequest: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsRemotes: (root: string) => Promise.resolve({ status: "ok", data: mocks.remotes(root) }),
      vcsConfigGet: (root: string, key: string) => Promise.resolve({ status: "ok", data: mocks.config(root, key) }),
    },
  };
});
vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  rest: mocks.rest,
}));
vi.mock("./toolwindow/open", () => ({ openPullRequest: mocks.openPullRequest }));

afterEach(() => {
  useGhRepository.setState({ connection: null });
  vi.resetAllMocks();
});

it("opens only the review of the tracked branch from the connected worktree group", async () => {
  const stop = activateWorktreeReviews();
  try {
    expect(useWorktreeReviewProvider.getState().lookup).toBeNull();
    useGhRepository.setState({
      connection: {
        root: "C:/repo/review",
        coordinates: { owner: "org", name: "base" },
      } as GHConnection,
    });
    const lookup = useWorktreeReviewProvider.getState().lookup!;
    expect(await lookup({ root: "C:/unrelated", paths: [], branches: ["feature"] })).toEqual(new Map());
    expect(mocks.remotes).not.toHaveBeenCalled();

    mocks.remotes.mockReturnValue([{ name: "origin", url: "https://github.com/org/base.git" }]);
    const config: Record<string, string> = {
      "branch.feature.remote": "origin",
      "branch.feature.merge": "refs/heads/remote-feature",
      "branch.closed.remote": "origin",
      "branch.closed.merge": "refs/pull/5/head",
    };
    mocks.config.mockImplementation((_root, key: string) => config[key] ?? null);
    mocks.rest
      .mockResolvedValueOnce([
        { number: 3, title: "Different fork", state: "open", head: { repo: { full_name: "org/other" } } },
        { number: 7, title: "Matching review", state: "open", head: { repo: { full_name: "org/base" } } },
      ])
      .mockResolvedValueOnce({ number: 5, title: "Closed review", state: "closed" });

    const reviews = await lookup({
      root: "C:/repo/main",
      paths: ["c:\\repo\\review"],
      branches: ["feature", "closed", "no-upstream"],
    });
    expect(mocks.remotes).toHaveBeenCalledExactlyOnceWith("C:/repo/review");
    expect(mocks.rest).toHaveBeenCalledWith(
      "GET",
      "repos/org/base/pulls?state=open&head=org%3Aremote-feature&per_page=1",
    );
    expect(mocks.rest).toHaveBeenCalledWith("GET", "repos/org/base/pulls/5");
    expect([...reviews.keys()]).toEqual(["feature"]);
    expect(reviews.get("feature")?.title).toBe("Matching review");
    await reviews.get("feature")?.open();
    expect(mocks.openPullRequest).toHaveBeenCalledExactlyOnceWith(7);
    useGhRepository.setState({ connection: null });
    await reviews.get("feature")?.open();
    expect(mocks.openPullRequest).toHaveBeenCalledTimes(1);
    expect(useWorktreeReviewProvider.getState().lookup).toBeNull();
  } finally {
    stop();
  }
});
