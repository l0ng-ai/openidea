import { afterEach, describe, expect, it, vi } from "vitest";

const executeAction = vi.fn(async () => true);
let registered = true;
vi.mock("./actions", async (orig) => ({
  ...(await orig<typeof import("./actions")>()),
  executeAction,
  getAction: (id: string) => (registered && id === "java.downloadJdk" ? { id } : undefined),
}));

const { downloadJdkActions, isDownloadJdkArgs, requiredJdk } = await import("./jdk");

afterEach(() => {
  registered = true;
  vi.clearAllMocks();
});

// Issue #49, verbatim from the run console (Windows, JDK 8 / 17 / 21 installed).
const ISSUE_49 =
  "jdtls needs JDK 25 or newer to run (found JDK 8, 17, 21). Pick one in Settings › Languages & Frameworks › Java › Language Server › JDK (it restarts automatically), or install a newer JDK and restart the server; the project can still target an older Java version.";

describe("JDK requirements in launch / sync errors", () => {
  it.each([
    [ISSUE_49, { version: 25, languageServer: true }],
    [
      "The language server JDK (C:\\Java\\jdk-21, JDK 21) is too old: jdtls needs JDK 25 or newer. Download JDK 25, choose another one in Settings › Languages & Frameworks › Java › Language Server › JDK, or set it to Auto.",
      { version: 25, languageServer: true },
    ],
    [
      "This project targets Java 21: it needs JDK 21 or newer (found JDK 17). Download JDK 21, or choose a Project JDK in Settings › Languages & Frameworks › Java.",
      { version: 21, languageServer: false },
    ],
    [
      "This project targets Java 17: it needs JDK 17 or newer (no JDK was found). Download JDK 17, or choose a Project JDK in Settings › Languages & Frameworks › Java.\n[ERROR] Failed to execute goal",
      { version: 17, languageServer: false },
    ],
    ["The language server JDK /x is not a JDK home (Settings › Languages & Frameworks › Java).", null],
    ["`rust-analyzer` was not found on PATH", null],
    [null, null],
  ])("%s", (message, expected) => {
    expect(requiredJdk(message)).toEqual(expected);
  });

  it("offers Download JDK N, which runs the download action", () => {
    const [fix, ...rest] = downloadJdkActions(ISSUE_49);
    expect(rest).toEqual([]);
    expect(fix!.label).toBe("Download JDK 25");
    fix!.run();
    expect(executeAction).toHaveBeenCalledWith("java.downloadJdk", { version: 25, languageServer: true });
    expect(downloadJdkActions("jdtls crashed")).toEqual([]);
  });

  it("offers nothing where no window can download (e.g. without the tools feature)", () => {
    registered = false;
    expect(downloadJdkActions(ISSUE_49)).toEqual([]);
  });

  it("recognises the action's argument", () => {
    expect(isDownloadJdkArgs({ version: 25 })).toBe(true);
    expect(isDownloadJdkArgs({ version: "25" })).toBe(false);
    expect(isDownloadJdkArgs(undefined)).toBe(false);
  });
});
