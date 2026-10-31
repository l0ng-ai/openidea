import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 20, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

beforeEach(() => usePlatform.setState({ os: "macos" }));

function setup(text = "alpha beta\ngamma Beta\nbeta again\n") {
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text });
  const view = render(
    <ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />,
  );
  const log = screen.getByRole("log");
  return { model, log, view };
}

function openFind(log: HTMLElement) {
  fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
  return screen.getByRole("search");
}

function input() {
  return screen.getByRole("textbox", { name: "Find in console" });
}

function type(query: string) {
  fireEvent.change(input(), { target: { value: query } });
}

function markCount(container: HTMLElement) {
  return container.querySelectorAll("[data-find-match]").length;
}

describe("Run console find", () => {
  it("opens on ⌘F, searches as you type and highlights every match", () => {
    const { log, view } = setup();
    const bar = openFind(log);
    expect(bar).toBeInTheDocument();
    expect(input()).toHaveFocus();

    type("beta");
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(markCount(view.container)).toBe(3);
    expect(view.container.querySelectorAll("[data-find-current]")).toHaveLength(1);
  });

  it("moves through matches with Enter / Shift+Enter and wraps around", () => {
    const { log } = setup();
    openFind(log);
    type("beta");
    const bar = screen.getByRole("search");
    expect(screen.getByText("1/3")).toBeInTheDocument();

    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getByText("2/3")).toBeInTheDocument();
    fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it("supports match case, words and regex", () => {
    const { log, view } = setup();
    openFind(log);
    type("beta");
    expect(screen.getByText("1/3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Match Case" }));
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(markCount(view.container)).toBe(2);

    fireEvent.change(input(), { target: { value: "b.ta" } });
    expect(screen.getByText("0 results")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("reports an invalid regular expression", () => {
    const { log } = setup();
    openFind(log);
    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    type("(");
    expect(screen.getByText("Bad regex")).toBeInTheDocument();
  });

  it("closes on Escape, clears the highlights and returns focus to the console", () => {
    const { log, view } = setup();
    openFind(log);
    type("beta");
    expect(markCount(view.container)).toBe(3);

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(markCount(view.container)).toBe(0);
    expect(log).toHaveFocus();
  });

  it("seeds the field with the selected console text", () => {
    const { log } = setup();
    const text = screen.getByText("gamma Beta");
    const range = document.createRange();
    range.setStart(text.firstChild!, 0);
    range.setEnd(text.firstChild!, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    openFind(log);
    expect(input()).toHaveValue("gamma");
  });

  it("shows no matches when nothing matches", () => {
    const { log, view } = setup();
    openFind(log);
    type("nothing");
    expect(screen.getByText("0 results")).toBeInTheDocument();
    expect(markCount(view.container)).toBe(0);
  });

  it("runs the bar in a controlled open state", () => {
    const onOpenChange = vi.fn();
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: "one two" });
    render(
      <ConsoleView
        model={model}
        version={1}
        softWrap={false}
        follow={false}
        onFollowChange={() => {}}
        cwd="/"
        findOpen
        onFindOpenChange={onOpenChange}
      />,
    );
    expect(screen.getByRole("search")).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
