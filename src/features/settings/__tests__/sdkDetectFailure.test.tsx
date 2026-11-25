import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      sdkDetect: () =>
        Promise.resolve({ status: "error", error: { kind: "unavailable", message: "detection failed", data: null } }),
    },
  };
});

import { detectSdks } from "../languages/api";
import { useDetected } from "../languages/components";

describe("useDetected", () => {
  it("stops loading when detection fails", async () => {
    const { result } = renderHook(() => useDetected("jdk"));
    expect(result.current.loading).toBe(true);
    await act(() => detectSdks("jdk"));
    expect(result.current.loading).toBe(false);
    expect(result.current.list).toEqual([]);
    expect(result.current.error).toContain("detection failed");
  });
});
