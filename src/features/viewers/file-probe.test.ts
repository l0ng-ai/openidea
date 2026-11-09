import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, type FileProbe } from "@/platform/ipc";
import { resolveFileEditor } from "@/workbench/contributions";
import { activate } from "./index";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe("file probes", () => {
  it.each([false, true])("shares an in-flight probe without caching its result (binary: %s)", async (binary) => {
    let finish!: (result: { status: "ok"; data: FileProbe }) => void;
    const pending = new Promise<{ status: "ok"; data: FileProbe }>((resolve) => {
      finish = resolve;
    });
    const probe = vi.spyOn(commands, "fsProbe").mockReturnValue(pending);
    dispose = activate();
    const first = resolveFileEditor("/p/a.ts");
    const second = resolveFileEditor("/p/a.ts");
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    finish({ status: "ok", data: { size: 12, binary, tooLarge: false } });
    const resolutions = await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(resolutions.map((r) => r?.input.kind ?? "file")).toEqual(binary ? ["binary", "binary"] : ["file", "file"]);
    if (binary) expect(resolutions[0]).not.toBe(resolutions[1]);
    probe.mockResolvedValue({ status: "ok", data: { size: 20, binary: !binary, tooLarge: false } });
    expect((await resolveFileEditor("/p/a.ts"))?.input.kind ?? "file").toBe(binary ? "file" : "binary");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("retries a failed probe", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const probe = vi
      .spyOn(commands, "fsProbe")
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue({ status: "ok", data: { size: 20, binary: true, tooLarge: false } });
    dispose = activate();
    expect(await resolveFileEditor("/p/a.ts")).toBeNull();
    expect((await resolveFileEditor("/p/a.ts"))?.input.kind).toBe("binary");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes different files independently", async () => {
    const probe = vi.spyOn(commands, "fsProbe").mockResolvedValue({
      status: "ok",
      data: { size: 20, binary: false, tooLarge: false },
    });
    dispose = activate();
    await Promise.all([resolveFileEditor("/p/a.ts"), resolveFileEditor("/p/b.ts")]);
    expect(probe.mock.calls).toEqual([["/p/a.ts"], ["/p/b.ts"]]);
  });
});
