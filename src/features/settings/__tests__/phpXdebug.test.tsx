import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { Sdk } from "@/platform/ipc";

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const sdk = (path: string, version: string): Sdk => ({
  path,
  name: `PHP ${version}`,
  version,
  source: "system",
  home: null,
  extra: null,
});
const XDEBUG: Record<string, string | null> = { "/opt/php83/bin/php": "3.4.7", "/opt/php81/bin/php": null };
const mocks = vi.hoisted(() => ({ xdebug: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      sdkDetect: () => ok([sdk("/opt/php83/bin/php", "8.3.14"), sdk("/opt/php81/bin/php", "8.1.33")]),
      sdkLocateTools: () => ok({ tools: [{ name: "php", path: "/opt/php81/bin/php" }], compileDir: "/tmp" }),
      sdkPhpXdebug: mocks.xdebug,
    },
  };
});

import { PageContext } from "../components/context";
import { PhpPage } from "../languages/LanguagePages";
import { detectSdks } from "../languages/api";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, stage } from "../model/staging";

beforeEach(() => {
  mocks.xdebug.mockImplementation((php: string) =>
    php in XDEBUG
      ? ok({ php, phpVersion: php.includes("83") ? "8.3.14" : "8.1.33", xdebug: XDEBUG[php] })
      : Promise.resolve({ status: "error", error: { kind: "unavailable", message: "cannot run", data: null } }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function page(interpreter: string) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.languages.php.interpreter = interpreter;
  useProject.setState({ settings, project: null });
  openSettings("languages.php");
  render(
    <PageContext.Provider value={{ pageId: "languages.php", scope: "global" }}>
      <PhpPage />
    </PageContext.Provider>,
  );
}

/** The value of the CLI Interpreter row labelled `label`. */
const row = (label: string) => screen.queryByText(label, { selector: "label *" })?.closest("div")?.textContent;

describe("PHP settings: Xdebug row", () => {
  it("shows the Xdebug version of the selected PHP, re-checked when the interpreter changes", async () => {
    page("/opt/php83/bin/php");
    await waitFor(() => expect(row("Xdebug")).toContain("3.4.7"));
    expect(row("Version")).toContain("8.3.14");
    expect(mocks.xdebug).toHaveBeenCalledWith("/opt/php83/bin/php", null);

    let finish: () => void = () => {};
    mocks.xdebug.mockImplementationOnce(
      (php: string) =>
        new Promise((r) => (finish = () => r({ status: "ok", data: { php, phpVersion: "8.1.33", xdebug: null } }))),
    );
    act(() => stage("languages.php", "global", "languages.php.interpreter", "/opt/php81/bin/php"));
    expect(row("Version")).toContain("8.1.33");
    expect(row("Xdebug"), "not the previous PHP's Xdebug").toBeUndefined();
    await act(async () => finish());
    expect(row("Xdebug")).toContain("Not installed");
  });

  it("checks again when the interpreters are detected again", async () => {
    page("/opt/php81/bin/php");
    await waitFor(() => expect(row("Xdebug")).toContain("Not installed"));
    XDEBUG["/opt/php81/bin/php"] = "3.4.7";
    try {
      await act(() => detectSdks("php", true));
      await waitFor(() => expect(row("Xdebug")).toContain("3.4.7"));
    } finally {
      XDEBUG["/opt/php81/bin/php"] = null;
    }
  });

  it("checks the php on the search path for the Default interpreter", async () => {
    page("");
    await waitFor(() => expect(row("Xdebug")).toContain("Not installed"));
    expect(mocks.xdebug).toHaveBeenCalledWith("/opt/php81/bin/php", null);
  });

  it("hides the row while checking and when the check fails", async () => {
    let finish: (v: unknown) => void = () => {};
    mocks.xdebug.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    page("/opt/php83/bin/php");
    await waitFor(() => expect(row("Version")).toContain("8.3.14"));
    expect(row("Xdebug")).toBeUndefined();
    await act(async () =>
      finish({ status: "error", error: { kind: "unavailable", message: "timed out", data: null } }),
    );
    expect(row("Xdebug")).toBeUndefined();
  });
});
