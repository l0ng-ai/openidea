import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorDocContext } from "@/editor/api";
import { consoleExtension, executeInView } from "./console";
import { unsafeStatement } from "./sql/unsafe";
import { executeConsole, type ConfirmUnsafe } from "./store";

vi.mock("./store", async (original) => ({ ...(await original<typeof import("./store")>()), executeConsole: vi.fn() }));

const DOC = "select 1;\nDELETE FROM t_digital_tachometer_file WHERE 1=1;";
const FROM = DOC.indexOf("DELETE");
const TO = DOC.length - 1;

/** Runs the console's statement through `executeInView`, recording the unsafe-query answer. */
function run(view: EditorView, path: string) {
  let answer: boolean | undefined;
  vi.mocked(executeConsole).mockImplementationOnce(async (_p, _t, _f, _to, confirm?: ConfirmUnsafe) => {
    const text = DOC.slice(FROM, TO);
    answer = await confirm!({ from: FROM, to: TO, text }, unsafeStatement(text, "postgres")!);
    return [];
  });
  const done = executeInView(view, path);
  return { done, answer: () => answer };
}

const flush = () => act(async () => {});
const banner = (view: EditorView) => view.dom.querySelector(".cm-openidea-db-banner-warning");
const button = (view: EditorView, label: string) =>
  [...view.dom.querySelectorAll<HTMLButtonElement>(".cm-openidea-db-banner button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!;

describe("unsafe query warning", () => {
  const views: EditorView[] = [];
  afterEach(() => views.splice(0).forEach((v) => v.destroy()));

  function open(path: string) {
    const ctx = { language: "sql", path, virtual: false, readOnly: false } as unknown as EditorDocContext;
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: consoleExtension(ctx) }),
      parent: document.body,
    });
    views.push(view);
    return view;
  }

  it("asks before running and marks the always-true condition", async () => {
    const view = open("/p/console.sql");
    const first = run(view, "/p/console.sql");
    await flush();
    expect(banner(view)?.textContent).toContain(
      "Unsafe query: 'Delete' statement clears all data in the table because 'where' condition is always true",
    );
    expect(view.dom.querySelector(".cm-openidea-db-warning")?.textContent).toBe("1=1");
    expect(first.answer()).toBeUndefined();

    button(view, "Close").click();
    await first.done;
    expect(first.answer()).toBe(false);
    expect(banner(view)).toBeNull();
    expect(view.dom.querySelector(".cm-openidea-db-warning")).toBeNull();

    const second = run(view, "/p/console.sql");
    await flush();
    button(view, "Execute").click();
    await second.done;
    expect(second.answer()).toBe(true);
    expect(banner(view)).toBeNull();
  });

  it("stops asking in that console after Execute and Suppress", async () => {
    const view = open("/p/other.sql");
    const first = run(view, "/p/other.sql");
    await flush();
    button(view, "Execute and Suppress").click();
    await first.done;
    expect(first.answer()).toBe(true);

    const second = run(view, "/p/other.sql");
    await second.done;
    expect(second.answer()).toBe(true);
    expect(banner(view)).toBeNull();
  });
});
