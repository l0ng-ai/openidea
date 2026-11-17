import { afterEach, describe, expect, it, vi } from "vitest";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  canOpenWithSystemApp,
  canRevealInFileManager,
  fileManagerName,
  fileManagerPath,
  openWithSystemApp,
  revealInFileManager,
  revealInFileManagerLabel,
  showInFileManagerLabel,
} from "./fileManager";
import { _resetI18nForTests, setLocale, tx } from "./i18n";
import { commands, type RemoteTarget } from "./ipc";
import { usePlatform } from "./platformInfo";
import { useRemote } from "./remote";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  isTauri: () => true,
}));

const raw = String.raw;

afterEach(() => _resetI18nForTests());

describe("file manager labels", () => {
  it.each([
    ["macos", "Finder", "Reveal in Finder"],
    ["windows", "Explorer", "Show in Explorer"],
    ["linux", "Files", "Show in Files"],
    ["web", "Files", "Show in Files"],
  ])("names the %s file manager in submenus and project actions", (os, name, label) => {
    expect(fileManagerName(os)).toBe(name);
    expect(revealInFileManagerLabel(os)).toBe(label);
  });

  it("translates the project action on every desktop platform", async () => {
    await setLocale("zh");
    expect(tx(revealInFileManagerLabel("macos"))).toBe("在访达中显示");
    expect(tx(revealInFileManagerLabel("windows"))).toBe("在资源管理器中显示");
    expect(tx(revealInFileManagerLabel("linux"))).toBe("在文件管理器中显示");
  });
});

describe("showInFileManagerLabel", () => {
  it("names the file manager of the platform instead of always Finder", () => {
    expect(showInFileManagerLabel("macos")).toBe("Show in Finder");
    expect(showInFileManagerLabel("windows")).toBe("Show in Explorer");
    expect(showInFileManagerLabel("linux")).toBe("Show in Files");
    expect(showInFileManagerLabel("web")).toBe("Show in Files");
  });

  it("is translated into the platform's file manager, not Finder", async () => {
    await setLocale("zh");
    expect(tx(showInFileManagerLabel("macos"))).toBe("在访达中显示");
    expect(tx(showInFileManagerLabel("windows"))).toBe("在资源管理器中显示");
    expect(tx(showInFileManagerLabel("linux"))).toBe("在文件管理器中显示");
  });
});

describe("revealInFileManager", () => {
  const platform = usePlatform.getState();
  afterEach(() => {
    usePlatform.setState(platform);
    useRemote.setState({ session: null });
    vi.mocked(revealItemInDir).mockClear();
  });

  const ssh: RemoteTarget = { kind: "ssh", config: "box" };
  const container: RemoteTarget = { kind: "devContainer", folder: "/Users/me/app", config: "" };
  it.each<{ window: string; os: string; target: RemoteTarget | null; path: string; revealed: string | null }>([
    { window: "a local window", os: "macos", target: null, path: "/Users/me/app/a.ts", revealed: "/Users/me/app/a.ts" },
    {
      window: "a WSL window on Windows",
      os: "windows",
      target: { kind: "wsl", distro: "Ubuntu" },
      path: "/home/me/app/a.ts",
      revealed: raw`\\wsl.localhost\Ubuntu\home\me\app\a.ts`,
    },
    { window: "an SSH window on macOS", os: "macos", target: ssh, path: "/srv/app/a.ts", revealed: null },
    { window: "an SSH window on Windows", os: "windows", target: ssh, path: "/srv/app/a.ts", revealed: null },
    { window: "a dev-container window", os: "macos", target: container, path: "/workspaces/app/a.ts", revealed: null },
  ])("in $window passes only paths this desktop has to the OS", async ({ os, target, path, revealed }) => {
    usePlatform.setState({ os });
    useRemote.setState({ session: target && { target, root: "/p", host: "h", os: "linux", commands: [] } });
    const shown = await revealInFileManager(path);
    if (revealed) expect(revealItemInDir).toHaveBeenCalledExactlyOnceWith(revealed);
    else expect(revealItemInDir).not.toHaveBeenCalled();
    expect(shown).toBe(revealed !== null);
    expect(canRevealInFileManager()).toBe(revealed !== null);
  });

  it("reveals this desktop's own files from a remote window", async () => {
    usePlatform.setState({ os: "macos" });
    useRemote.setState({ session: { target: ssh, root: "/p", host: "h", os: "linux", commands: [] } });
    expect(await revealInFileManager("/Users/me/Library/Logs/openidea.log", null)).toBe(true);
    expect(revealItemInDir).toHaveBeenCalledExactlyOnceWith("/Users/me/Library/Logs/openidea.log");
  });
});

describe("openWithSystemApp", () => {
  afterEach(() => {
    useRemote.setState({ session: null });
    vi.restoreAllMocks();
  });

  const ssh: RemoteTarget = { kind: "ssh", config: "box" };
  const container: RemoteTarget = { kind: "devContainer", folder: "/Users/me/app", config: "" };
  const wsl: RemoteTarget = { kind: "wsl", distro: "Ubuntu" };
  it.each<{ window: string; target: RemoteTarget | null; path: string; launched: boolean }>([
    { window: "a local window", target: null, path: "/Users/me/a.xlsx", launched: true },
    { window: "a WSL window", target: wsl, path: "/home/me/a.xlsx", launched: false },
    { window: "an SSH window", target: ssh, path: "/srv/app/a.xlsx", launched: false },
    { window: "a dev-container window", target: container, path: "/workspaces/app/a.xlsx", launched: false },
  ])("in $window asks the backend only for this desktop's own files", async ({ target, path, launched }) => {
    const open = vi.spyOn(commands, "fsOpenWithSystem").mockResolvedValue({ status: "ok", data: null });
    useRemote.setState({ session: target && { target, root: "/p", host: "h", os: "linux", commands: [] } });
    expect(await openWithSystemApp(path)).toBe(launched);
    if (launched) expect(open).toHaveBeenCalledExactlyOnceWith(path);
    else expect(open).not.toHaveBeenCalled();
    expect(canOpenWithSystemApp()).toBe(launched);
  });

  it("reports a refused launch so the caller can fall back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(commands, "fsOpenWithSystem").mockResolvedValue({
      status: "error",
      error: { kind: "invalid", message: "outside the project" } as never,
    });
    expect(await openWithSystemApp("/Users/me/a.xyz")).toBe(false);
  });
});

describe("fileManagerPath", () => {
  it("converts verbatim UNC paths to the form Windows Shell accepts", () => {
    expect(
      fileManagerPath(
        raw`\\?\UNC\192.168.10.9\nas\apps\ignis\vaults\我的知识库\111health工作\生产日志分析`,
        "windows",
        null,
      ),
    ).toBe(raw`\\192.168.10.9\nas\apps\ignis\vaults\我的知识库\111health工作\生产日志分析`);
    expect(
      fileManagerPath(
        "//?/UNC/192.168.10.9/nas/apps/ignis/vaults/我的知识库/111health工作/生产日志分析",
        "windows",
        null,
      ),
    ).toBe(raw`\\192.168.10.9\nas\apps\ignis\vaults\我的知识库\111health工作\生产日志分析`);
    expect(fileManagerPath(raw`\\?\unc\server\share`, "windows", null)).toBe(raw`\\server\share`);
  });

  it("converts the UI's slash-separated Windows paths to native paths", () => {
    expect(fileManagerPath("//server/share/my notes", "windows", null)).toBe(raw`\\server\share\my notes`);
    expect(fileManagerPath("C:/work/my project", "windows", null)).toBe(raw`C:\work\my project`);
    expect(fileManagerPath(raw`\\?\C:\work\my project`, "windows", null)).toBe(raw`C:\work\my project`);
    expect(fileManagerPath("//?/C:/work/my project", "windows", null)).toBe(raw`C:\work\my project`);
  });

  it("leaves native Windows paths and non-Windows paths alone", () => {
    expect(fileManagerPath(raw`\\server\share\my notes`, "windows", null)).toBe(raw`\\server\share\my notes`);
    expect(fileManagerPath("/home/me/my notes", "linux", null)).toBe("/home/me/my notes");
    expect(fileManagerPath("/Users/me/my notes", "macos", null)).toBe("/Users/me/my notes");
  });

  it("translates a WSL distro path to a shell-compatible share on Windows", () => {
    expect(fileManagerPath("/home/me/my app", "windows", { kind: "wsl", distro: "Ubuntu-24.04" })).toBe(
      raw`\\wsl.localhost\Ubuntu-24.04\home\me\my app`,
    );
  });
});
