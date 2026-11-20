import { useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerActions } from "@/platform/actions";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";
import { ChatLayout } from "./ChatLayout";
import { taskActions } from "./taskActions";
import { useAgents } from "./store";

const mounts = vi.hoisted(() => ({ session: 0, editor: 0 }));
vi.mock("./SessionEditor", () => ({
  SessionEditor: () => {
    useEffect(() => {
      mounts.session++;
    }, []);
    return <input aria-label="Conversation draft" defaultValue="Unsent conversation" />;
  },
}));
vi.mock("./HomeEditor", () => ({ HomeEditor: () => <div>New conversation form</div> }));

function FileEditor() {
  const [text, setText] = useState("File draft");
  useEffect(() => {
    mounts.editor++;
  }, []);
  return <input aria-label="File draft" value={text} onChange={(event) => setText(event.target.value)} />;
}
let dispose: () => void;
beforeEach(() => {
  mounts.session = mounts.editor = 0;
  localStorage.removeItem("openidea.agents.chatPaneSizes.v1");
  useAgents.setState({ sessionLocation: "pane", chatSide: "right", docked: "task", homeOpen: false });
  dispose = registerActions(taskActions);
});
afterEach(() => dispose());

it("moves only the conversation body, retaining file and conversation DOM and drafts", () => {
  const layout = useToolWindowLayout.getState();
  render(
    <ChatLayout>
      <FileEditor />
    </ChatLayout>,
  );
  const editor = screen.getByRole("textbox", { name: "File draft" });
  const composer = screen.getByRole("textbox", { name: "Conversation draft" });
  fireEvent.change(editor, { target: { value: "Unsaved file" } });
  fireEvent.change(composer, { target: { value: "Unsent message" } });
  for (const side of ["left", "top", "bottom", "right"] as const) {
    act(() => useAgents.setState({ chatSide: side }));
    expect(document.querySelector("[data-chat-side]")?.getAttribute("data-chat-side")).toBe(side);
    expect(screen.getByRole("textbox", { name: "File draft" })).toBe(editor);
    expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(composer);
    expect(editor).toHaveValue("Unsaved file");
    expect(composer).toHaveValue("Unsent message");
    expect(useToolWindowLayout.getState()).toBe(layout);
  }
  expect(mounts).toEqual({ editor: 1, session: 1 });
  act(() => useAgents.setState({ sessionLocation: "editor", docked: null }));
  expect(screen.queryByRole("region", { name: "Agent Chat" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "File draft" })).toBe(editor);
});

it.each([
  ["right", "ArrowLeft", 380],
  ["left", "ArrowRight", 380],
  ["top", "ArrowDown", 300],
  ["bottom", "ArrowUp", 300],
] as const)("resizes the %s conversation separately and hides only its body", (side, key, expected) => {
  useAgents.setState({ chatSide: side });
  const layout = useToolWindowLayout.getState();
  const tasks = useAgents.getState().tasks;
  render(
    <ChatLayout>
      <FileEditor />
    </ChatLayout>,
  );
  const separator = screen.getByRole("separator", { name: "Resize conversation pane" });
  vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 1200, height: 800 } as DOMRect);
  fireEvent.keyDown(separator, { key });
  expect(separator).toHaveAttribute("aria-valuenow", String(expected));
  expect(JSON.parse(localStorage.getItem("openidea.agents.chatPaneSizes.v1")!)[side]).toBe(expected);
  fireEvent.click(screen.getByRole("button", { name: "Hide Conversation" }));
  expect(screen.queryByRole("region", { name: "Agent Chat" })).toBeNull();
  expect(useAgents.getState().sessionLocation).toBe("pane");
  expect(useAgents.getState().tasks).toBe(tasks);
  expect(useToolWindowLayout.getState()).toBe(layout);
  expect(screen.getByRole("textbox", { name: "File draft" })).toBeTruthy();
});
