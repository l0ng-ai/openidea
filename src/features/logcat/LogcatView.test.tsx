import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AndroidDevice, IdeError, LogcatLine, RequestId } from "@/platform/ipc";
import { LogcatView } from "./LogcatView";
import { resetLogcat, useLogcat } from "./store";

const devices: AndroidDevice[] = ["A", "B"].map((serial) => ({
  serial,
  state: "device",
  model: null,
  product: null,
  device: null,
  transportId: null,
}));

interface Stream {
  serial: string;
  request: RequestId;
  onLines: Channel<LogcatLine[]>;
  finish: () => void;
  fail: (error: IdeError) => void;
}

function append(stream: Stream, message: string) {
  stream.onLines.onmessage([{ time: "11-04 12:52:39.123", pid: 1, tid: 1, level: "info", tag: "test", message }]);
}

const messages = () => useLogcat.getState().lines.map((line) => line.message);

describe("Logcat streams", () => {
  let streams: Stream[];
  let cancelled: RequestId[];

  beforeEach(() => {
    resetLogcat();
    streams = [];
    cancelled = [];
    mockIPC((cmd, args) => {
      if (cmd === "android_devices") return devices;
      if (cmd === "android_logcat") {
        return new Promise<null>((resolve, reject) => {
          streams.push({ ...(args as Omit<Stream, "finish" | "fail">), finish: () => resolve(null), fail: reject });
        });
      }
      if (cmd === "cancel_request") cancelled.push((args as { id: RequestId }).id);
    });
  });

  afterEach(async () => {
    cleanup();
    await act(async () => streams.forEach((stream) => stream.finish()));
    clearMocks();
    resetLogcat();
  });

  it("ignores the previous device's batches and cancellation, including while paused", async () => {
    await act(async () => void render(<LogcatView />));
    const first = streams[0]!;
    act(() => append(first, "Device A before switch"));
    expect(messages()).toEqual(["Device A before switch"]);

    fireEvent.click(screen.getByRole("button", { name: "Device" }));
    fireEvent.click(screen.getByRole("option", { name: "B" }));
    const second = streams[1]!;
    expect(second.serial).toBe("B");
    expect(cancelled).toEqual([first.request]);
    expect(messages()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => {
      append(second, "Current device B");
      append(first, "Late device A");
    });
    await act(async () => first.fail({ kind: "cancelled", message: "Cancelled", data: null }));
    expect(screen.getByText("Streaming")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(messages()).toEqual(["Current device B"]);
  });

  it.each(["completion", "error"])("ignores a closed stream's %s after reopening the same device", async (terminal) => {
    await act(async () => void render(<LogcatView />));
    const first = streams[0]!;
    act(() => append(first, "Existing buffer"));
    cleanup();
    await act(async () => void render(<LogcatView />));
    const second = streams[1]!;
    expect(second.serial).toBe(first.serial);
    expect(cancelled).toEqual([first.request]);

    await act(async () => {
      append(first, "Late from closed stream");
      if (terminal === "completion") first.finish();
      else first.fail({ kind: "internal", message: "Old connection failed", data: null });
      append(second, "Reopened stream");
    });
    expect(messages()).toEqual(["Existing buffer", "Reopened stream"]);
    expect(screen.getByText("Streaming")).toBeVisible();
    await act(async () => second.finish());
    expect(screen.getByText("Idle")).toBeVisible();
  });
});
