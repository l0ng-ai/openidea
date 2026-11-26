import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebConnection } from "@/platform/webBridge";
import * as contributions from "./contributions";
import { installWebSessionGuard } from "./webSessionGuard";

function fireBeforeUnload() {
  const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(event);
  return event;
}

describe("webSessionGuard", () => {
  let dispose: () => void;

  beforeEach(() => {
    useWebConnection.setState({
      active: false,
      status: "idle",
      windowLabel: "main",
      serverHome: "",
      serverOs: "linux",
    });
    dispose = installWebSessionGuard();
  });

  afterEach(() => {
    dispose();
    vi.restoreAllMocks();
    useWebConnection.setState({
      active: false,
      status: "idle",
      windowLabel: "main",
      serverHome: "",
      serverOs: "linux",
    });
  });

  it("is inactive outside web mode even when documents are dirty", () => {
    vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
      dirtyDocumentIds: () => [1],
      untitledDirtyDocumentIds: () => [2],
    } as unknown as contributions.EditorService);

    const event = fireBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not prevent unload in web mode when all documents are clean", () => {
    useWebConnection.setState({ active: true, status: "connected" });
    vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
      dirtyDocumentIds: () => [],
      untitledDirtyDocumentIds: () => [],
    } as unknown as contributions.EditorService);

    const event = fireBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
  });

  it("prevents unload in web mode when dirtyDocumentIds is non-empty", () => {
    useWebConnection.setState({ active: true, status: "connected" });
    vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
      dirtyDocumentIds: () => [42],
      untitledDirtyDocumentIds: () => [],
    } as unknown as contributions.EditorService);

    const event = fireBeforeUnload();
    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents unload in web mode when untitledDirtyDocumentIds is non-empty", () => {
    useWebConnection.setState({ active: true, status: "connected" });
    vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
      dirtyDocumentIds: () => [],
      untitledDirtyDocumentIds: () => [7],
    } as unknown as contributions.EditorService);

    const event = fireBeforeUnload();
    expect(event.defaultPrevented).toBe(true);
  });

  it("removes the beforeunload listener on dispose", () => {
    useWebConnection.setState({ active: true, status: "connected" });
    vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
      dirtyDocumentIds: () => [1],
      untitledDirtyDocumentIds: () => [],
    } as unknown as contributions.EditorService);

    dispose();
    const event = fireBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
  });
});
