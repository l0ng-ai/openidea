import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useEditorBanners } from "@/workbench/contributions";
import { activate } from "../conflictBanner";
import { useVcs } from "../store";

function status(path: string, unstaged: "conflicted" | "modified") {
  const file = { path, staged: null, unstaged };
  useVcs.setState({ status: [file as never], byPath: new Map([[path, file as never]]) });
}

describe("the conflict banner", () => {
  let dispose = () => {};
  afterEach(() => {
    // Unmount first: a mounted hook would render again once the banner is gone.
    cleanup();
    dispose();
    useVcs.setState({ status: [], byPath: new Map() });
  });

  const contribution = () => {
    dispose = activate();
    return useEditorBanners.getState().banners.get("vcs.conflict")!;
  };

  it("warns above a file Git records as conflicted, and offers to resolve it", () => {
    const banner = contribution();
    status("/p/settings.gradle", "conflicted");
    const { result } = renderHook(() => banner.useBanner("/p/settings.gradle"));
    expect(result.current).toMatchObject({
      level: "warning",
      text: "File has unresolved merge conflicts",
      actions: [{ label: "Resolve conflicts…" }],
    });
  });

  it("shows nothing above other files, and goes away when the conflict is resolved", () => {
    const banner = contribution();
    status("/p/settings.gradle", "conflicted");
    const other = renderHook(() => banner.useBanner("/p/other.gradle"));
    expect(other.result.current).toBeNull();
    const { result } = renderHook(() => banner.useBanner("/p/settings.gradle"));
    expect(result.current).not.toBeNull();
    act(() => status("/p/settings.gradle", "modified"));
    expect(result.current).toBeNull();
  });
});
