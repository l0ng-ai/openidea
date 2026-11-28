import type { Branch, Commit } from "@/bindings";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const repoBranches = vi.hoisted(() => new Map<string, Branch[]>());
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranches: async (root: string) => ({ status: "ok", data: repoBranches.get(root) ?? [] }),
      vcsTags: async () => ({ status: "ok", data: [] }),
      vcsLog: async () => ({ status: "ok", data: [] }),
      vcsConfigGet: async () => ({ status: "ok", data: null }),
    },
  };
});

import { useContextKeys } from "@/platform/context";
import { useProject } from "@/platform/project";
import { ContextMenuHost } from "@/ui";
import { BranchFilterPopup } from "../BranchFilterPopup";
import { BranchesPopupHost, showBranchesPopup, useBranchesPopup } from "../BranchWidget";
import { favoriteBranches, setFavoriteBranch, toggleFavoriteBranch, useFavoriteBranches } from "../branchOps";
import { isFavoriteBranch } from "../branches";
import { branchMenu } from "../branchMenu";
import { BranchesPanel } from "../log/BranchesPanel";
import { commitMenu } from "../log/commitMenu";
import { registerLogPaneActions } from "../logPaneActions";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const branch = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: null,
  commit: "1",
  ...opts,
});
const list = (...extra: Branch[]) => [
  branch("main", { current: true }),
  branch("develop"),
  branch("feature"),
  ...extra,
];

const A = "/work/a";
const B = "/work/b";
const LEGACY = "openidea.vcs.favoriteBranches:/work";
const v2 = (repo: string, project = "/work") => `openidea.vcs.favoriteBranches.v2:${JSON.stringify([project, repo])}`;
const initialVcs = useVcs.getState();

function multiRepo(a = list(), b = list()) {
  repoBranches.set(A, a);
  repoBranches.set(B, b);
  useProject.setState({ settings: { vcs: { git: { syncBranchOperations: false } } } } as never);
  useVcs.setState({
    available: true,
    root: "/work",
    roots: [A, B],
    repo: A,
    branches: a,
    branchesLoaded: true,
    heads: { [A]: { head: "main", headCommit: "1" }, [B]: { head: "main", headCommit: "1" } },
    branch: { head: "main", headCommit: "1", upstream: null, ahead: 0, behind: 0, operation: null },
  });
}

beforeEach(() => {
  localStorage.clear();
  useFavoriteBranches.setState(useFavoriteBranches.getInitialState(), true);
  useGitLog.setState({ filters: emptyFilters() });
});

afterEach(() => {
  useBranchesPopup.setState({ open: false });
  useVcs.setState(initialVcs);
  useProject.setState({ settings: undefined } as never);
  repoBranches.clear();
});

// --- Branches popup ----------------------------------------------------------

/** The star of `name`'s row inside `scope`. */
const star = (scope: HTMLElement, name: string, key?: RegExp) => {
  const rows = within(scope)
    .getAllByText(name, { selector: "[data-row-key] *" })
    .map((el) => el.closest<HTMLElement>("[data-row-key]")!)
    .filter((row) => !key || key.test(row.dataset.rowKey!));
  expect(rows).toHaveLength(1);
  return within(rows[0]!).getByRole("button", { name: /Favorites/ });
};

async function openRepoMenu(name: string) {
  const list = screen.getByRole("listbox", { name: "Repositories and branches" });
  fireEvent.click(await within(list).findByText(name, { selector: "[data-row-key] *" }));
  return screen.findByRole("dialog", { name: `Branches of ${name}` });
}

function openPopup() {
  render(<BranchesPopupHost />);
  act(showBranchesPopup);
  return screen.getByRole("listbox", { name: "Repositories and branches" });
}

describe("Branches popup with several repositories", () => {
  it("a star in one repository's submenu stays out of the other repository", async () => {
    multiRepo();
    const top = openPopup();
    fireEvent.click(star(await openRepoMenu("b"), "develop"));
    expect(star(await openRepoMenu("b"), "develop")).toHaveAttribute("aria-pressed", "true");
    // a, at the top of the popup and in its own submenu.
    expect(star(top, "develop")).toHaveAttribute("aria-pressed", "false");
    expect(star(await openRepoMenu("a"), "develop")).toHaveAttribute("aria-pressed", "false");
  });

  it("search rows of another repository show and toggle that repository's favorites", async () => {
    multiRepo();
    const top = openPopup();
    fireEvent.click(star(await openRepoMenu("b"), "feature"));
    await waitFor(() =>
      expect(star(screen.getByRole("dialog", { name: "Branches of b" }), "feature")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search for branches, actions, repositories" }), {
      target: { value: "feature" },
    });
    const own = await waitFor(() => star(top, "feature", /^branch:\/work\/a:/));
    const other = star(top, "feature", /^branch:\/work\/b:/);
    expect([own, other].map((s) => s.getAttribute("aria-pressed"))).toEqual(["false", "true"]);

    fireEvent.click(other);
    await waitFor(() => expect(star(top, "feature", /^branch:\/work\/b:/)).toHaveAttribute("aria-pressed", "false"));
    expect(localStorage.getItem(v2(A))).toBeNull();
  });

  it("the first star in a repository keeps that repository's default favorites", async () => {
    // Only b has origin/main, a default favorite.
    multiRepo(list(), list(branch("origin/main", { remote: true })));
    openPopup();
    const menu = await openRepoMenu("b");
    fireEvent.click(star(menu, "develop"));
    await waitFor(() => expect(star(menu, "develop")).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(within(menu).getByText("Remote"));
    expect(star(menu, "main", /remote/)).toHaveAttribute("aria-pressed", "true");
  });

  it("the submenu's Add to Favorites edits that repository", async () => {
    multiRepo();
    openPopup();
    const menu = await openRepoMenu("b");
    fireEvent.click(within(menu).getByText("feature"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add to Favorites" }));
    // The menu closes the popup and runs in b once it is selected.
    await waitFor(() => expect(useVcs.getState().repo).toBe(B));
    act(showBranchesPopup);
    await waitFor(async () => expect(star(await openRepoMenu("b"), "feature")).toHaveAttribute("aria-pressed", "true"));
    expect(star(await openRepoMenu("a"), "feature")).toHaveAttribute("aria-pressed", "false");
  });
});

// --- migration ---------------------------------------------------------------

describe("favorites saved per project before", () => {
  it("apply to every repository, and unstarring in one leaves the others and the saved list alone", async () => {
    multiRepo();
    localStorage.setItem(LEGACY, JSON.stringify(["develop"]));
    const top = openPopup();
    expect(await waitFor(() => star(top, "develop"))).toHaveAttribute("aria-pressed", "true");
    expect(star(await openRepoMenu("b"), "develop")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(star(top, "develop"));
    await waitFor(() => expect(star(top, "develop")).toHaveAttribute("aria-pressed", "false"));
    expect(star(await openRepoMenu("b"), "develop")).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(LEGACY)).toBe(JSON.stringify(["develop"]));
    expect(JSON.parse(localStorage.getItem(v2(A))!)).toEqual([]);
    // An emptied list is the repository's own: the old list does not come back.
    useFavoriteBranches.setState(useFavoriteBranches.getInitialState(), true);
    expect(star(await openRepoMenu("a"), "develop")).toHaveAttribute("aria-pressed", "false");
  });
});

// --- single repository: unchanged -------------------------------------------

describe("a project with one repository", () => {
  function single(root: string, repo: string) {
    const branches = list(branch("origin/main", { remote: true }));
    repoBranches.set(repo, branches);
    useVcs.setState({
      available: true,
      root,
      roots: [repo],
      repo,
      branches,
      branchesLoaded: true,
      heads: { [repo]: { head: "main", headCommit: "1" } },
      branch: { head: "main", headCommit: "1", upstream: null, ahead: 0, behind: 0, operation: null },
    });
  }
  const popupStars = () => {
    const list = screen.getByRole("listbox", { name: "Branches" });
    return ["main", "develop", "feature"].map((n) =>
      n === "main" ? "current" : star(list, n).getAttribute("aria-pressed"),
    );
  };

  it.each([
    ["at the project folder", "/work/a", "/work/a"],
    ["above the project folder", "/work/a/sub", "/work/a"],
  ])("keeps the favorites saved for the project when the repository is %s", async (_, root, repo) => {
    single(root, repo);
    localStorage.setItem(`openidea.vcs.favoriteBranches:${root}`, JSON.stringify(["feature"]));
    render(<BranchesPopupHost />);
    act(showBranchesPopup);
    expect(popupStars()).toEqual(["current", "false", "true"]);

    fireEvent.click(star(screen.getByRole("listbox", { name: "Branches" }), "develop"));
    await waitFor(() => expect(popupStars()).toEqual(["current", "true", "true"]));
    // Still there in a later session.
    useFavoriteBranches.setState(useFavoriteBranches.getInitialState(), true);
    act(() => useBranchesPopup.setState({ open: false }));
    act(showBranchesPopup);
    expect(popupStars()).toEqual(["current", "true", "true"]);
  });

  it("starts from main and origin/main, as before", async () => {
    single("/work/a", "/work/a");
    render(<BranchesPopupHost />);
    act(showBranchesPopup);
    fireEvent.click(star(screen.getByRole("listbox", { name: "Branches" }), "develop"));
    await waitFor(() => expect(popupStars()).toEqual(["current", "true", "false"]));
    act(() => useBranchesPopup.setState({ open: false }));
    useVcs.setState({ branches: repoBranches.get("/work/a")!, branchesLoaded: true });
    act(showBranchesPopup);
    fireEvent.click(screen.getByText("Remote"));
    expect(star(screen.getByRole("listbox", { name: "Branches" }), "main", /remote|origin/)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

// --- Git Log -----------------------------------------------------------------

describe("Git Log Branches pane", () => {
  let dispose: () => void;
  beforeAll(() => {
    dispose = registerLogPaneActions();
    useContextKeys.setState({ vcsAvailable: true });
  });
  afterAll(() => {
    dispose();
    useContextKeys.setState({ vcsAvailable: false });
  });
  const panel = () =>
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );
  const menuLabel = async (node: HTMLElement) => {
    fireEvent.contextMenu(node);
    const item = await screen.findByRole("menuitem", { name: /Favorites$/ });
    const label = item.textContent;
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: /Favorites$/ })).toBeNull());
    return label;
  };
  /** Local branch labels of each repository subtree, in order. */
  const grouped = () =>
    screen
      .getAllByRole("treeitem")
      .map((row) => row.textContent)
      .join(" | ");

  beforeEach(() => localStorage.removeItem("openidea.vcs.branchesPane.groupByRepository"));
  afterEach(() => localStorage.removeItem("openidea.vcs.branchesPane.groupByRepository"));

  it("lists each repository with its own favorites when grouped by repository", async () => {
    multiRepo();
    localStorage.setItem("openidea.vcs.branchesPane.groupByRepository", "true");
    panel();
    await screen.findAllByText("feature");
    fireEvent.contextMenu(screen.getAllByText("feature")[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add to Favorites" }));
    await waitFor(() => expect(grouped()).toMatch(/main.*develop.*feature.*main.*feature.*develop/));
    const [aFeature, bFeature] = screen.getAllByText("feature");
    expect(await menuLabel(bFeature!)).toBe("Remove from Favorites");
    expect(await menuLabel(aFeature!)).toBe("Add to Favorites");
  });

  /** The toolbar star's state with the log showing `repositories` (none: all). */
  const toolbarStar = async (repositories: string[], name = "feature") => {
    act(() => useGitLog.setState({ filters: { ...emptyFilters(), repositories } }));
    fireEvent.mouseDown(await screen.findByText(name));
    return screen.getByRole("button", { name: /Favorites$/ });
  };

  it("a branch listed once for several repositories is a favorite in any, and its star sets all of them", async () => {
    multiRepo();
    panel();
    fireEvent.click(await toolbarStar([]));
    expect((await toolbarStar([A])).getAttribute("aria-pressed")).toBe("true");
    expect((await toolbarStar([B])).getAttribute("aria-pressed")).toBe("true");

    // Unstarred in b only: still a favorite of a, so the merged row keeps its star.
    fireEvent.click(await toolbarStar([B]));
    expect((await toolbarStar([B])).getAttribute("aria-pressed")).toBe("false");
    expect((await toolbarStar([])).getAttribute("aria-pressed")).toBe("true");
    expect(await menuLabel(screen.getByText("feature"))).toBe("Remove from Favorites");

    fireEvent.click(await toolbarStar([]));
    expect((await toolbarStar([A])).getAttribute("aria-pressed")).toBe("false");
    expect((await toolbarStar([B])).getAttribute("aria-pressed")).toBe("false");
  });

  it("a tab showing one repository reads and edits that repository's favorites", async () => {
    multiRepo();
    panel();
    fireEvent.click(await toolbarStar([B], "develop"));
    expect((await toolbarStar([B], "develop")).getAttribute("aria-pressed")).toBe("true");
    expect((await toolbarStar([A], "develop")).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Git Log branch filter", () => {
  it("lists the favorites of the repositories the log shows", () => {
    multiRepo();
    void toggleFavoriteBranch(branch("feature"), B, list());
    const props = {
      anchor: document.body,
      branches: list(),
      selected: [],
      onSelect: vi.fn(),
      onSelectMany: vi.fn(),
      onClose: vi.fn(),
    };
    const favorites = () => {
      const texts = screen.getAllByRole("option").map((o) => o.textContent);
      return texts.slice(1, texts.indexOf("Local"));
    };
    const { rerender } = render(<BranchFilterPopup {...props} repos={[A]} />);
    expect(favorites()).not.toContain("feature");
    rerender(<BranchFilterPopup {...props} repos={[B]} />);
    expect(favorites()).toContain("feature");
    rerender(<BranchFilterPopup {...props} repos={[A, B]} />);
    expect(favorites()).toContain("feature");
  });
});

// --- menus built outside the panes -------------------------------------------

describe("branch menus of another repository", () => {
  type Item = { label?: string; submenu?: Item[]; run?: () => void };
  const find = (items: readonly Item[], label: string) => items.find((i) => i.label === label);
  const favoriteLabel = (items: readonly Item[]) => items.find((i) => i.label?.endsWith("Favorites"))?.label;

  it("a commit's Branch submenu reads and edits the commit's repository", async () => {
    multiRepo();
    void toggleFavoriteBranch(branch("develop"), B, list());
    const commit = (repo: string) =>
      ({
        id: "0123456789abcdef0123456789abcdef01234567",
        shortId: "01234567",
        parents: [],
        author: "A",
        email: "a@example.com",
        timeMs: 0,
        summary: "x",
        message: "x",
        refs: [],
        repo,
        refBranches: [branch("develop")],
      }) as Commit;
    const submenu = (repo: string) => find(commitMenu(commit(repo)) as Item[], "Branch 'develop'")!.submenu!;
    expect(favoriteLabel(submenu(B))).toBe("Remove from Favorites");
    expect(favoriteLabel(submenu(A))).toBe("Add to Favorites");

    act(() => find(submenu(A), "Add to Favorites")!.run!());
    await waitFor(() => expect(favoriteLabel(submenu(A))).toBe("Remove from Favorites"));
    act(() => find(submenu(B), "Remove from Favorites")!.run!());
    await waitFor(() => expect(favoriteLabel(submenu(B))).toBe("Add to Favorites"));
    expect(favoriteLabel(submenu(A))).toBe("Remove from Favorites");
  });

  it("a Tracked Branch submenu reads the repository of its branch", () => {
    multiRepo();
    const tracked = branch("origin/feature", { remote: true });
    const branches = list(tracked);
    void toggleFavoriteBranch(tracked, B, branches);
    const feature = branch("feature", { upstream: "origin/feature" });
    const trackedMenu = (repo: string) =>
      find(branchMenu(feature, "main", undefined, { branches, repo }) as Item[], "Tracked Branch 'origin/feature'")!
        .submenu!;
    expect(favoriteLabel(trackedMenu(B))).toBe("Remove from Favorites");
    expect(favoriteLabel(trackedMenu(A))).toBe("Add to Favorites");
  });
});

describe("a linked worktree", () => {
  it("shares its repository's favorites", async () => {
    const linked = "/work/a-linked";
    const branches = list();
    repoBranches.set(A, branches);
    repoBranches.set(linked, branches);
    useVcs.setState({
      available: true,
      root: A,
      roots: [A, linked],
      branchRoots: { [linked]: A },
      repo: linked,
      branches,
      branchesLoaded: true,
      heads: { [A]: { head: "main", headCommit: "1" }, [linked]: { head: "main", headCommit: "1" } },
      branch: { head: "main", headCommit: "1", upstream: null, ahead: 0, behind: 0, operation: null },
    });
    void toggleFavoriteBranch(branch("develop"), linked, branches);
    useVcs.setState({ repo: A });
    render(<BranchesPopupHost />);
    act(showBranchesPopup);
    const popup = await screen.findByRole("listbox", { name: /Branches/ });
    expect(await waitFor(() => star(popup, "develop"))).toHaveAttribute("aria-pressed", "true");
  });
});

describe("favorites of the same repository in another project", () => {
  it("favorites saved for another project of the same repository survive", async () => {
    localStorage.setItem("openidea.vcs.favoriteBranches:/p/a", JSON.stringify(["x"]));
    useVcs.setState({
      root: "/p",
      roots: ["/p/a", "/p/b"],
      repo: "/p/a",
      branches: list(branch("x")),
      branchesLoaded: true,
    });
    await setFavoriteBranch(branch("develop"), true, "/p/a", list(branch("x")));
    useFavoriteBranches.setState(useFavoriteBranches.getInitialState(), true);
    useVcs.setState({ root: "/p/a", roots: ["/p/a"], repo: "/p/a" });
    expect(isFavoriteBranch(branch("x"), favoriteBranches())).toBe(true);
  });

  it("two projects on folders of one repository keep their own favorites", async () => {
    localStorage.setItem("openidea.vcs.favoriteBranches:/mono/pkg1", JSON.stringify(["release"]));
    const branches = list(branch("release"));
    useVcs.setState({ root: "/mono/pkg2", roots: ["/mono"], repo: "/mono", branches, branchesLoaded: true });
    await setFavoriteBranch(branch("develop"), true, "/mono", branches);
    useFavoriteBranches.setState(useFavoriteBranches.getInitialState(), true);
    useVcs.setState({ root: "/mono/pkg1" });
    expect(favoriteBranches()).toEqual(["release"]);
    useVcs.setState({ root: "/mono/pkg2" });
    expect(favoriteBranches()).toEqual(["main", "develop"]);
  });
});
