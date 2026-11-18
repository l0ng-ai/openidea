import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _emitEditorEvent } from "@/editor/api";
import { commands, emitLocalIdeEvent } from "@/platform/ipc";
import { WebEditor } from "./WebEditor";
import { togglePreview, useWebPreview } from "./browsers";

const path = "/project/site/index.html";
const url = "http://127.0.0.1:43210/token/project/site/index.html";
const style = "/project/shared/main.css";
const script = "/project/site/app.js";
const frame = () => screen.getByTitle("HTML preview");
const save = (path: string) => _emitEditorEvent({ type: "docSaved", doc: 1, path });
const change = (...modified: string[]) => emitLocalIdeEvent({ type: "fsChanged", created: [], modified, removed: [] });

describe("HTML preview reload", () => {
  let html: string;

  beforeEach(async () => {
    html = '<link rel="stylesheet" href="../shared/main.css?version=1"><script src="app.js" defer></script>';
    vi.spyOn(commands, "webUrl").mockResolvedValue({ status: "ok", data: url });
    vi.spyOn(commands, "fsReadText").mockImplementation(async () => ({ status: "ok", data: html }));
    togglePreview(path, true);
    render(
      <WebEditor path={path} tabId="page">
        HTML editor
      </WebEditor>,
    );
    await screen.findByTitle("HTML preview");
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useWebPreview.setState({}, true);
  });

  async function after(event: () => void) {
    await act(async () => {
      event();
      await vi.advanceTimersByTimeAsync(300);
    });
    return frame();
  }

  it("keeps the same iframe after unrelated files are saved, including unlinked web assets", async () => {
    const original = frame();
    expect(
      await after(() => change("/project/site/notes.txt", "/project/site/unused.css", "/project/other.html")),
    ).toBe(original);
    expect(await after(() => save("/project/site/unused.js"))).toBe(original);
    expect(await after(() => emitLocalIdeEvent({ type: "docDirty", doc: 2, dirty: false }))).toBe(original);
  });

  it("reloads when linked CSS or JS changes and refreshes dependencies on HTML save", async () => {
    const original = frame();
    const afterStyle = await after(() => change(style));
    expect(afterStyle).not.toBe(original);
    const afterScript = await after(() => save(script));
    expect(afterScript).not.toBe(afterStyle);

    html = '<base href="../shared/"><script src="replacement.js"></script>';
    const afterPage = await after(() => save(path));
    expect(afterPage).not.toBe(afterScript);
    expect(await after(() => change(script, style))).toBe(afterPage);
    expect(await after(() => change("/project/shared/replacement.js"))).not.toBe(afterPage);
  });
});
