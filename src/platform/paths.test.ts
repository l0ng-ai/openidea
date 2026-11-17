import { describe, expect, it } from "vitest";
import { ipcPath, onOtherShare, opensOtherShare } from "./paths";

const raw = String.raw;
const APPDATA = raw`C:\Users\me\AppData\Roaming\ai.l0ng.openidea`;

describe("ipcPath", () => {
  it("slashes Windows drive paths, plain or verbatim", () => {
    expect(ipcPath(APPDATA)).toBe("C:/Users/me/AppData/Roaming/ai.l0ng.openidea");
    expect(ipcPath(raw`\\?\C:\Users\me`)).toBe("C:/Users/me");
  });

  it("slashes network shares", () => {
    expect(ipcPath(raw`\\server\share\dir`)).toBe("//server/share/dir");
    expect(ipcPath(raw`\\?\UNC\server\share\dir`)).toBe("//server/share/dir");
  });

  it("leaves UI paths and POSIX paths alone", () => {
    expect(ipcPath("C:/Users/me")).toBe("C:/Users/me");
    expect(ipcPath("/home/me/notes")).toBe("/home/me/notes");
    // A backslash is a legal character in a POSIX file name.
    expect(ipcPath(raw`/home/me/a\b.txt`)).toBe(raw`/home/me/a\b.txt`);
  });
});

describe("onOtherShare", () => {
  it("is true for a share the base is not on", () => {
    for (const base of ["C:/repo/a.md", "", "//nas/work/a.md", "//evil/other/a.md", "//evil"]) {
      expect(onOtherShare("//evil/share/a.png", base), base).toBe(true);
      expect(onOtherShare(raw`\\evil\share\a.png`, base), base).toBe(true);
    }
    // A server alone, and spellings with no server to compare.
    for (const path of ["//evil", "//evil/", raw`/\\evil/share/a.png`]) {
      expect(onOtherShare(path, "//evil/share/a.md"), path).toBe(true);
    }
  });

  // A project on a share gets its paths from the host as `//?/UNC/server/share/…`.
  it("reads the server and share of a device path", () => {
    const base = "//?/UNC/nas/work/app/a.md";
    expect(onOtherShare("//?/UNC/evil/share/a.png", base)).toBe(true);
    expect(onOtherShare("//?/UNC/nas/private/a.png", base)).toBe(true);
    expect(onOtherShare("//evil/share/a.png", base)).toBe(true);
    expect(onOtherShare("//?/UNC", base)).toBe(true);
    expect(onOtherShare("//?/C:/a.png", "//?/C:/a.md")).toBe(true);
    expect(onOtherShare("//?/unc/NAS/Work/lib/a.png", base)).toBe(false);
    expect(onOtherShare("//nas/work/lib/a.png", base)).toBe(false);
    expect(onOtherShare("//?/UNC/nas/work/lib/a.png", "//nas/work/app/a.md")).toBe(false);
  });

  it("is false on the base's own share and off any share", () => {
    expect(onOtherShare("//NAS/Work/lib/a.png", "//nas/work/app/a.md")).toBe(false);
    expect(onOtherShare(raw`\\nas\work\lib\a.png`, "//nas/work/app/a.md")).toBe(false);
    expect(onOtherShare("C:/repo/a.png", "//nas/work/app/a.md")).toBe(false);
    expect(onOtherShare("/abs/a.png", "C:/repo/a.md")).toBe(false);
  });
});

describe("opensOtherShare", () => {
  it("is true for a share the text names itself, in any mix of slashes", () => {
    for (const written of ["//evil/share/a.png", raw`\\evil\share\a.png`, raw`/\evil/share/a.png`, raw`\/evil/a.png`]) {
      expect(opensOtherShare(written, written, "C:/repo"), written).toBe(true);
      expect(opensOtherShare(written, written, "//nas/work"), written).toBe(true);
    }
  });

  it("is true for a share that only appears once the path is resolved", () => {
    expect(opensOtherShare(raw`/\evil/share/a.png`, raw`\evil/share/a.png`, "")).toBe(true);
    expect(opensOtherShare(raw`/\evil/share/a.png`, raw`../\evil/share/a.png`, "/guide.md")).toBe(true);
    expect(opensOtherShare("//evil/share/a.png", "a.png", "//nas/work")).toBe(true);
  });

  it("is false on a local drive and on the share the text is on", () => {
    expect(opensOtherShare("C:/repo/docs/a.png", "docs/a.png", "C:/repo")).toBe(false);
    expect(opensOtherShare("/abs/a.png", "/abs/a.png", "C:/repo")).toBe(false);
    expect(opensOtherShare("//nas/work/docs/a.png", "docs/a.png", "//nas/work")).toBe(false);
  });
});
