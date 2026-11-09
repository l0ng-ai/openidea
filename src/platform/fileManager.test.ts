import { describe, expect, it } from "vitest";
import { fileManagerPath } from "./fileManager";

const raw = String.raw;

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
    expect(
      fileManagerPath("/home/me/my app", "windows", {
        target: { kind: "wsl", distro: "Ubuntu-24.04" },
        root: "/p",
        host: "Ubuntu",
        os: "linux",
        commands: [],
      }),
    ).toBe(raw`\\wsl.localhost\Ubuntu-24.04\home\me\my app`);
  });
});
