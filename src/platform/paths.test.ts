import { describe, expect, it } from "vitest";
import { ipcPath } from "./paths";

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
