import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMenuFor, copyText, selectableText } from "./selectableText";

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body;
}

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("selectableText", () => {
  it("is a real class name", () => {
    expect(selectableText).toBeTruthy();
  });
});

describe("copyMenuFor", () => {
  it("offers Copy of the selection in a selectable pane (issue #36: Markdown preview)", () => {
    mount(`<div class="${selectableText}" role="document"><p id="p">Hello <b id="b">world</b></p></div>`);
    select(document.getElementById("p")!);
    const items = copyMenuFor(document.getElementById("b"));
    expect(items).toHaveLength(1);
    expect(items![0]).toMatchObject({ label: "Copy", disabled: false });
  });

  it("offers a disabled Copy in a selectable pane with nothing selected", () => {
    mount(`<div class="${selectableText}"><p id="p">Hello</p></div>`);
    expect(copyMenuFor(document.getElementById("p"))![0]).toMatchObject({ label: "Copy", disabled: true });
  });

  it("resolves text-node targets", () => {
    mount(`<div class="${selectableText}"><p id="p">Hello</p></div>`);
    expect(copyMenuFor(document.getElementById("p")!.firstChild)).not.toBeNull();
  });

  it("offers Copy on a selection in any pane that opted in with its own CSS", () => {
    mount(`<pre id="console">line 1</pre>`);
    select(document.getElementById("console")!);
    expect(copyMenuFor(document.getElementById("console"))![0]).toMatchObject({ disabled: false });
  });

  it("stays out of chrome without a selection", () => {
    mount(`<button id="b">Run</button><div id="row">tree row</div>`);
    expect(copyMenuFor(document.getElementById("b"))).toBeNull();
    expect(copyMenuFor(document.getElementById("row"))).toBeNull();
  });

  it("ignores a selection elsewhere when right-clicking chrome", () => {
    mount(`<div class="${selectableText}"><p id="p">Hello</p></div><div id="row">tree row</div>`);
    select(document.getElementById("p")!);
    expect(copyMenuFor(document.getElementById("row"))).toBeNull();
  });

  it.each(["<input id='t'>", "<textarea id='t'></textarea>", "<div id='t' contenteditable='true'>x</div>"])(
    "leaves editable targets alone: %s",
    (html) => {
      mount(`<div class="${selectableText}">${html}</div>`);
      expect(copyMenuFor(document.getElementById("t"))).toBeNull();
    },
  );

  it("copies the text captured when the menu opened", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount(`<div class="${selectableText}"><p id="p">Hello</p></div>`);
    select(document.getElementById("p")!);
    const items = copyMenuFor(document.getElementById("p"))!;
    window.getSelection()!.removeAllRanges();
    (items[0] as { run: () => void }).run();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("Hello");
  });

  it("falls back to execCommand when the clipboard API is missing", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    await copyText("x");
    expect(exec).toHaveBeenCalledWith("copy");
  });
});
