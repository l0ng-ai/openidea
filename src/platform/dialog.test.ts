// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("opens every file picker through the platform wrapper", () => {
  const src = resolve(import.meta.dirname, "..");
  const offenders = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
    (file) =>
      /\.[jt]sx?$/.test(file) &&
      !/\.test\.[jt]sx?$/.test(file) &&
      file.replace(/\\/g, "/") !== "platform/dialog.ts" &&
      readFileSync(resolve(src, file), "utf8").includes("@tauri-apps/plugin-" + "dialog"),
  );
  expect(offenders).toEqual([]);
});
