import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TargetBranchInput, stripRemotePrefix, suggestRemoteBranches } from "../TargetBranchInput";
import { recentPushTargets, rememberPushTarget } from "../pushHistory";

const branches = ["main", "feature/login", "fix/error-auth", "release/2.0"];

function Harness(props: { initial?: string; remote?: string | null; branches?: string[] }) {
  const [value, setValue] = useState(props.initial ?? "main");
  return (
    <TargetBranchInput
      value={value}
      onChange={setValue}
      branches={props.branches ?? branches}
      remote={props.remote === undefined ? "origin" : props.remote}
      repo="/p"
      source="main"
    />
  );
}

const input = () => screen.getByRole("combobox", { name: "Target branch" });

describe("stripRemotePrefix", () => {
  it("drops the chosen remote's prefix", () => {
    expect(stripRemotePrefix("origin/feat", "origin")).toBe("feat");
    expect(stripRemotePrefix("origin/feature/login", "origin")).toBe("feature/login");
    expect(stripRemotePrefix("Origin/feat", "origin")).toBe("feat");
  });

  it("keeps a name without that prefix", () => {
    expect(stripRemotePrefix("feat", "origin")).toBe("feat");
    expect(stripRemotePrefix("upstream/feat", "origin")).toBe("upstream/feat");
    expect(stripRemotePrefix("origin/feat", null)).toBe("origin/feat");
  });
});

describe("suggestRemoteBranches", () => {
  it("returns nothing until something is typed", () => {
    expect(suggestRemoteBranches(branches, "", "origin")).toEqual([]);
    expect(suggestRemoteBranches(branches, "   ", "origin")).toEqual([]);
  });

  it("fuzzy-matches branch names, prefix matches first, then in their order", () => {
    expect(
      suggestRemoteBranches(["fix/very-old", "dev/fe-ui", "feature/a", "feature/b"], "fe", null).map((s) => s.name),
    ).toEqual(["feature/a", "feature/b", "dev/fe-ui", "fix/very-old"]);
    expect(suggestRemoteBranches(branches, "fea", "origin").map((s) => s.name)).toEqual([
      "feature/login",
      "fix/error-auth",
    ]);
    expect(suggestRemoteBranches(branches, "fea", "origin")[0]!.match).toEqual([0, 1, 2]);
    expect(suggestRemoteBranches(branches, "err", "origin").map((s) => s.name)).toEqual(["fix/error-auth"]);
  });

  it("ignores the remote prefix the user may type", () => {
    expect(suggestRemoteBranches(branches, "origin/release", "origin").map((s) => s.name)).toEqual(["release/2.0"]);
    expect(suggestRemoteBranches(branches, "upstream/release", "origin")).toEqual([]);
  });
});

describe("target branch field", () => {
  beforeEach(() => localStorage.clear());

  it("lists the remote branches a typed name matches", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "log" } });
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["feature/login"]);
    expect(screen.getByRole("listbox", { name: "Remote branches" })).toBeTruthy();
    // Contiguous matches are one highlight run.
    expect([...document.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["log"]);
  });

  it("fills in the branch picked from the list", () => {
    render(<Harness />);
    const field = input();
    fireEvent.change(field, { target: { value: "e" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("fix/error-auth");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("leaves Enter alone until a row is chosen", () => {
    render(<Harness />);
    const field = input();
    fireEvent.change(field, { target: { value: "fea" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // The typed name stays: the push must never go to a branch the user did not pick.
    expect(field).toHaveValue("fea");
  });

  it("keeps a name the remote does not have yet", () => {
    render(<Harness />);
    const field = input();
    fireEvent.change(field, { target: { value: "release/3.0" } });
    expect(screen.getByText("No matching remote branches")).toBeTruthy();
    expect(field).toHaveValue("release/3.0");
  });

  it("hides the list once the field loses focus", () => {
    render(<Harness />);
    const field = input();
    fireEvent.change(field, { target: { value: "fea" } });
    expect(screen.queryByRole("listbox")).toBeTruthy();
    fireEvent.blur(field);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ranks recent targets first, labels them and keeps each name unique", () => {
    rememberPushTarget("/p", { source: "main", remote: "origin", target: "feature/login" });
    rememberPushTarget("/p", { source: "main", remote: "origin", target: "review/feature" });
    rememberPushTarget("/p", { source: "other", remote: "origin", target: "feature/other" });
    rememberPushTarget("/p", { source: "main", remote: "fork", target: "feature/fork" });
    rememberPushTarget("/other", { source: "main", remote: "origin", target: "feature/unrelated" });
    render(<Harness branches={["feature/login", "feature/regular"]} />);
    fireEvent.change(input(), { target: { value: "fea" } });
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
      "review/featureRecently pushed",
      "feature/loginRecently pushed",
      "feature/regular",
    ]);
  });

  it("browses recent targets without editing the default and reloads the next time the list opens", () => {
    render(<Harness />);
    const field = input();
    rememberPushTarget("/p", { source: "main", remote: "origin", target: "review/old" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const old = screen.getByRole("option", { name: /review\/old.*recently pushed/i });
    expect(field).toHaveAttribute("aria-activedescendant", old.id);
    expect(field).toHaveValue("main");
    fireEvent.keyDown(field, { key: "Escape" });
    rememberPushTarget("/p", { source: "main", remote: "origin", target: "review/new" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("review/new");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("bounds history per repository across sources and remotes", () => {
    rememberPushTarget("/other", { source: "main", remote: "origin", target: "review/separate" });
    rememberPushTarget("/p", { source: "main", remote: "origin", target: "review/old" });
    for (let i = 0; i < 9; i++) {
      rememberPushTarget("/p", { source: i % 2 ? "topic" : "main", remote: "fork", target: `review/${i}` });
    }
    rememberPushTarget("/p", { source: "main", remote: "origin", target: "review/new" });
    expect(recentPushTargets("/p", "main", "origin")).toEqual(["review/new"]);
    expect(recentPushTargets("/other", "main", "origin")).toEqual(["review/separate"]);
  });
});
