import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type RemoteSession } from "./ipc";
import { useRemote } from "./remote";
import { canDragOut, dragOut, isDraggingOut } from "./dragOut";

beforeEach(() => vi.stubGlobal("__TAURI_INTERNALS__", {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useRemote.setState({ session: null });
});

describe("dragging files out of the window", () => {
  it("is offered for a local project in the desktop app only", () => {
    expect(canDragOut()).toBe(true);
    useRemote.setState({ session: { id: "remote" } as unknown as RemoteSession });
    expect(canDragOut()).toBe(false);
    useRemote.setState({ session: null });
    vi.unstubAllGlobals();
    expect(canDragOut()).toBe(false);
  });

  it("hands every path to one OS drag and reports whether another app took them", async () => {
    let end!: (dropped: boolean) => void;
    const drag = vi
      .spyOn(commands, "windowDragFiles")
      .mockReturnValue(new Promise((resolve) => (end = (data) => resolve({ status: "ok", data }))));
    const paths = ["/w/a b/中文.txt", "/w/src"];
    const result = dragOut(paths);
    expect(drag).toHaveBeenCalledExactlyOnceWith(paths);
    // Until it ends, OS drops on this window are the same files coming back.
    expect(isDraggingOut()).toBe(true);
    end(true);
    expect(await result).toBe(true);
    expect(isDraggingOut()).toBe(false);
  });

  it("stops ignoring drops at the next press when the drag never reports its end", () => {
    vi.spyOn(commands, "windowDragFiles").mockReturnValue(new Promise(() => {}));
    void dragOut(["/w/a.txt"]);
    expect(isDraggingOut()).toBe(true);
    window.dispatchEvent(new MouseEvent("pointerdown"));
    expect(isDraggingOut()).toBe(false);
  });

  it("ends quietly when the drag can't start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(commands, "windowDragFiles").mockResolvedValue({
      status: "error",
      error: { kind: "not_found", message: "not a local file: /srv/x" } as never,
    });
    expect(await dragOut(["/srv/x"])).toBe(false);
    expect(isDraggingOut()).toBe(false);
  });
});
