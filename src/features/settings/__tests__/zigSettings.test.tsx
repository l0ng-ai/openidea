import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { Sdk } from "@/platform/ipc";

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const zig = (path: string, version: string, source: string): Sdk => ({
  path,
  name: `Zig ${version}`,
  version,
  source,
  home: path,
  extra: null,
});
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      sdkDetect: (kind: string) =>
        ok(
          kind === "zig"
            ? [zig("/opt/homebrew/opt/zig/bin", "0.14.1", "system"), zig("/Users/dev/.zvm/0.13.0", "0.13.0", "zvm")]
            : [],
        ),
    },
  };
});

import { PageContext } from "../components/context";
import { ZigPage } from "../languages/LanguagePages";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings } from "../model/staging";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function page(setting: string) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.languages.zig.zig = setting;
  useProject.setState({ settings, project: null });
  openSettings("languages.zig");
  render(
    <PageContext.Provider value={{ pageId: "languages.zig", scope: "global" }}>
      <ZigPage />
    </PageContext.Provider>,
  );
}

describe("Zig settings page", () => {
  it("defaults to Auto and lists the detected toolchains", async () => {
    page("");
    const combo = screen.getByRole("button", { name: "Zig toolchain" });
    await waitFor(() => expect(combo).toHaveTextContent("Auto"));
    fireEvent.click(combo);
    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("Auto");
    expect(options[0]).toHaveTextContent("zig on PATH");
    expect(options[1]).toHaveTextContent("Zig 0.14.1");
    expect(options[2]).toHaveTextContent("Zig 0.13.0");
  });

  it("shows the selected toolchain's version", async () => {
    page("/opt/homebrew/opt/zig/bin");
    const combo = screen.getByRole("button", { name: "Zig toolchain" });
    await waitFor(() => expect(combo).toHaveTextContent("Zig 0.14.1"));
  });
});
