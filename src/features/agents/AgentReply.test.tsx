import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { AgentReply } from "./AgentReply";
import { copyReplyAction } from "./replyActions";

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify }) }));

const writeText = vi.fn();
let dispose: () => void;
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  notify.mockReset();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  dispose = registerAction(copyReplyAction);
});
afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const reply = [
  "**OpenIDEA v0.1.38 is out!**",
  "",
  "## Highlights",
  "",
  "- **Docker & Compose** run targets.",
  "- [Release notes](https://example.com/releases)",
  "",
  "```sh",
  "pnpm tauri dev",
  "```",
  "",
  "| Feature | Status |",
  "| --- | --- |",
  "| 中文 | Ready |",
  "",
].join("\n");

it("copies the exact Markdown source and briefly confirms success", async () => {
  vi.useFakeTimers();
  render(<AgentReply text={reply} cwd="/repo" />);
  expect(screen.getByRole("heading", { name: "Highlights" })).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" })));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(reply);
  expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeInTheDocument();
});

it("copies the latest streamed text and clears feedback when content changes", async () => {
  const { rerender } = render(<AgentReply text="**Partial**" cwd="/repo" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" })));
  rerender(<AgentReply text={reply} cwd="/repo" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" })));
  expect(writeText.mock.calls.map(([text]) => text)).toEqual(["**Partial**", reply]);
});

it("reports a clipboard failure without claiming success and allows retry", async () => {
  writeText.mockRejectedValueOnce(new Error("denied"));
  render(<AgentReply text={reply} cwd="/repo" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" })));
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Couldn't copy the reply" }));
  expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" })));
  expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
});

it.each(["", " \n\t"])("does not offer copying an empty reply (%j)", (text) => {
  render(<AgentReply text={text} cwd="/repo" />);
  expect(screen.queryByRole("button", { name: "Copy Markdown" })).not.toBeInTheDocument();
});
