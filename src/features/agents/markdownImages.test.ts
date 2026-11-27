import { expect, it } from "vitest";
import { imageTarget } from "./markdownImages";

it.each([
  ["images/code.png", "/repo", "/repo/images/code.png"],
  ["../code.png?v=2#preview", "/repo", "/repo/../code.png"],
  ["/tmp/截图%20one%23.png", "/repo", "/tmp/截图 one#.png"],
  ["file://localhost/tmp/code.png", "/repo", "/tmp/code.png"],
  ["C:/shots/code.png", "/repo", "C:/shots/code.png"],
  [String.raw`C:\shots\code.png`, "C:/repo", "C:/shots/code.png"],
  [String.raw`images\code.png`, String.raw`C:\repo`, "C:/repo/images/code.png"],
  [String.raw`\\server\share\code.png`, "C:/repo", "//server/share/code.png"],
  ["file://server/share/code.png", "C:/repo", "//server/share/code.png"],
  ["file:///C:/shots/code%20one.png", "C:/repo", "C:/shots/code one.png"],
])("resolves host image paths: %s", (src, cwd, path) => {
  expect(imageTarget(src, cwd)).toEqual({ path });
});

it.each([
  "",
  "#section",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,test",
  "ftp://example.com/x.png",
  "/tmp/%ZZ.png",
  "/tmp/code%00.png",
  "file:///tmp/%ZZ.png",
  "https://",
  "https://example.com/\ncode.png",
])("rejects unsupported or malformed sources: %s", (src) => {
  expect(imageTarget(src, "/repo")).toBeNull();
});

it("treats protocol-relative URLs as HTTPS, rather than host files", () => {
  expect(imageTarget("//example.com/code.png", "/repo")).toEqual({ url: "https://example.com/code.png" });
});
