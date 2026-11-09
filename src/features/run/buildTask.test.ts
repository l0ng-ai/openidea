import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { buildTask } from "./buildTask";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  setContext("build.running", false);
  setContext("build.lastStatus", null);
});

describe("before-launch build results", () => {
  it.each(["build.buildProject", "build.buildModule", "build.buildArtifacts"])(
    "awaits fresh results from %s",
    async (id) => {
      for (const [status, error] of [
        ["success", null],
        ["failed", "Build failed"],
        ["cancelled", "Build cancelled"],
        [null, "Build did not start"],
      ] as const) {
        setContext("build.lastStatus", "success");
        let finish!: () => void;
        dispose = registerAction({
          id,
          title: "Build",
          run: () =>
            new Promise<void>((resolve) => {
              finish = () => {
                setContext("build.lastStatus", status);
                resolve();
              };
            }),
        });
        let finished = false;
        const task = buildTask(id, { activate: false, wait: true }).then((value) => {
          finished = true;
          return value;
        });
        expect(getContext()["build.lastStatus"]).toBeNull();
        expect(finished).toBe(false);
        finish();
        expect(await task).toBe(error);
        dispose();
      }
    },
  );

  it("reports an existing build without changing its result", async () => {
    const run = vi.fn();
    dispose = registerAction({ id: "build.buildModule", title: "Build", run });
    setContext("build.running", true);
    setContext("build.lastStatus", "failed");
    expect(await buildTask("build.buildModule", {})).toBe("A build is already running");
    expect(run).not.toHaveBeenCalled();
    expect(getContext()["build.lastStatus"]).toBe("failed");
  });
});
