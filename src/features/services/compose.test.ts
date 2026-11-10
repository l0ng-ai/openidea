import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { notifyFilesMoved } from "@/platform/fileOps";
import { useProject } from "@/platform/project";
import type { Settings } from "@/platform/ipc";
import {
  activateComposeFiles,
  composeAutoDetectBanner,
  isComposeFile,
  noteComposeContent,
  setComposeFileOverride,
  useComposeFiles,
} from "./compose";

const ipc = vi.hoisted(() => ({ settingsSet: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: ipc,
}));

const settings = (overrides = {}): Settings => ({ files: { composeFileOverrides: overrides } }) as Settings;
let stop: () => void;

beforeEach(() => {
  ipc.settingsSet.mockReset().mockImplementation(async (_scope, _key, json) => ({
    status: "ok",
    data: settings(JSON.parse(json)),
  }));
  useProject.setState({ project: { root: "/p" } as never, settings: settings() });
  stop = activateComposeFiles();
});
afterEach(() => {
  stop();
  useProject.setState({ project: null, settings: null });
  useComposeFiles.setState({ overrides: {}, contentDetected: {} });
});

describe("Compose file choices", () => {
  it.each(["kept", "excluded"] as const)("persists %s in project settings and restores it", async (choice) => {
    await setComposeFileOverride("/p/stack.yml", choice);
    expect(ipc.settingsSet).toHaveBeenCalledWith(
      "project",
      "files.composeFileOverrides",
      JSON.stringify({ "stack.yml": choice }),
    );
    const saved = useProject.getState().settings;
    stop();
    useComposeFiles.setState({ overrides: {} });
    useProject.setState({ settings: saved });
    stop = activateComposeFiles();
    expect(useComposeFiles.getState().overrides).toEqual({ "/p/stack.yml": choice });
    expect(isComposeFile("/p/stack.yml")).toBe(choice === "kept");
  });

  it("preserves consecutive choices and follows file/folder moves and Undo", async () => {
    await Promise.all([
      setComposeFileOverride("/p/stack.yml", "kept"),
      setComposeFileOverride("/p/sub/other.yml", "excluded"),
    ]);
    await notifyFilesMoved([{ from: "/p/stack.yml", to: "/p/sub/stack.yml" }]);
    await notifyFilesMoved([{ from: "/p/sub", to: "/p/new" }]);
    expect(useComposeFiles.getState().overrides).toEqual({
      "/p/new/stack.yml": "kept",
      "/p/new/other.yml": "excluded",
    });
    await notifyFilesMoved([{ from: "/p/new", to: "/p/sub" }]);
    expect(useProject.getState().settings?.files?.composeFileOverrides).toEqual({
      "sub/stack.yml": "kept",
      "sub/other.yml": "excluded",
    });
  });

  it("clears detections and reads only the new project's choices on project switch", async () => {
    await setComposeFileOverride("/p/stack.yml", "kept");
    noteComposeContent("/p/other.yml", "services:\n  web:\n    image: nginx\n");
    useProject.setState({ project: { root: "/q" } as never, settings: settings({ "stack.yml": "excluded" }) });
    expect(useComposeFiles.getState()).toEqual({ overrides: { "/q/stack.yml": "excluded" }, contentDetected: {} });
  });

  it("resolves relative choices on Windows and keeps absolute paths outside the project", () => {
    useProject.setState({
      project: { root: "C:/project" } as never,
      settings: settings({ "docker/stack.yml": "kept", "D:/other.yml": "excluded" }),
    });
    expect(useComposeFiles.getState().overrides).toEqual({
      "C:/project/docker/stack.yml": "kept",
      "D:/other.yml": "excluded",
    });
  });

  it("leaves the banner choice unchanged when saving fails", async () => {
    ipc.settingsSet.mockRejectedValueOnce(new Error("read-only project"));
    await expect(setComposeFileOverride("/p/stack.yml", "excluded")).rejects.toThrow("read-only project");
    expect(useComposeFiles.getState().overrides).toEqual({});
  });

  it("offers the shared banner only for unconfirmed content detection", () => {
    noteComposeContent("/p/stack.yml", "services:\n  web:\n    image: nginx\n");
    expect(
      renderHook(() => composeAutoDetectBanner.useBanner("/p/stack.yml")).result.current?.actions?.map((a) => a.label),
    ).toEqual(["Not a Compose file", "Keep as Docker Compose"]);
    expect(renderHook(() => composeAutoDetectBanner.useBanner("/p/compose.yml")).result.current).toBeNull();
    expect(renderHook(() => composeAutoDetectBanner.useBanner("/p/kubernetes.yml")).result.current).toBeNull();
  });
});
