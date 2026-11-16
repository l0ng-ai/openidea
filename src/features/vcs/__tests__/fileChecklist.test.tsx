import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { FileStatus } from "@/bindings";
import { FileChecklist } from "../shelf";
import { useVcs } from "../store";

const file = (rel: string): FileStatus => ({
  path: `/repo/${rel}`,
  relPath: rel,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
});

const files = [
  file("src/chat/web/ChatApiController.java"),
  file("src/chat/web/ChatController.java"),
  file("src/chat/config/AiConfig.java"),
  file("pom.xml"),
];

function Harness() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(files.map((f) => f.path)));
  return <FileChecklist files={files} selected={selected} onChange={setSelected} label="Files to shelve" />;
}

const box = (name: string) => screen.getByRole("checkbox", { name: `Include ${name}` });

beforeEach(() => useVcs.setState({ root: "/repo" }));
afterEach(cleanup);

it("groups the files by directory, merging single-child chains and counting files", () => {
  render(<Harness />);
  expect(screen.getByRole("tree", { name: "Files to shelve" })).toBeTruthy();
  expect(screen.getByText("repo")).toBeTruthy();
  expect(screen.getByText("4 files")).toBeTruthy();
  expect(screen.getByText("src/chat")).toBeTruthy();
  expect(screen.getByText("3 files")).toBeTruthy();
  expect(screen.getByText("web")).toBeTruthy();
  expect(screen.getByText("2 files")).toBeTruthy();
  expect(box("pom.xml")).toBeChecked();
});

it("checks or clears a directory's files at once and shows a partly included one as mixed", () => {
  render(<Harness />);
  fireEvent.click(box("ChatController.java"));
  expect(box("ChatController.java")).not.toBeChecked();
  expect(box("web")).toHaveAttribute("aria-checked", "mixed");
  expect(box("src/chat")).toHaveAttribute("aria-checked", "mixed");
  expect(box("repo")).toHaveAttribute("aria-checked", "mixed");
  fireEvent.click(box("web"));
  expect(box("ChatController.java")).toBeChecked();
  expect(box("web")).toHaveAttribute("aria-checked", "true");
  fireEvent.click(box("src/chat"));
  for (const name of ["ChatApiController.java", "ChatController.java", "AiConfig.java"])
    expect(box(name)).not.toBeChecked();
  expect(box("pom.xml")).toBeChecked();
});
