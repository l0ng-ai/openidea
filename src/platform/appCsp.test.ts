// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The app's CSP, which Tauri sends as a response header with every HTML page it serves. */
function directives(): Map<string, string[]> {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const csp: string = conf.app.security.csp;
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), sources);
  }
  return map;
}

describe("app content security policy", () => {
  it("does not let any page embed the app's own pages", () => {
    expect(directives().get("frame-ancestors")).toEqual(["'none'"]);
  });
});
