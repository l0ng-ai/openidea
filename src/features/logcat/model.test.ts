import { describe, expect, it } from "vitest";
import type { LogcatLine } from "@/platform/ipc";
import { LEVEL_CLASS, LEVELS, filterLines, shortTime } from "./model";

const line = (level: LogcatLine["level"], tag: string, message: string, pid = 100): LogcatLine => ({
  time: "11-04 12:52:39.123",
  pid,
  tid: pid + 1,
  level,
  tag,
  message,
});

const lines = [
  line("verbose", "chatty", "starting up"),
  line("info", "ActivityManager", "Displayed com.example/.Main"),
  line("warn", "Glide", "Failed to load bitmap"),
  line("error", "flutter", "IllegalStateException: boom", 4242),
  { ...line("unknown", "", "--------- beginning of main") },
];

describe("filterLines", () => {
  it("keeps everything at the least severe level", () => {
    expect(filterLines(lines, "verbose", "")).toHaveLength(5);
  });

  it("drops lines below the chosen level", () => {
    expect(filterLines(lines, "warn", "").map((l) => l.tag)).toEqual(["Glide", "flutter", ""]);
    expect(filterLines(lines, "error", "").map((l) => l.tag)).toEqual(["flutter", ""]);
  });

  it("matches the tag, the message, and #pid", () => {
    expect(filterLines(lines, "verbose", "glide")).toHaveLength(1);
    expect(filterLines(lines, "verbose", "bitmap")).toHaveLength(1);
    expect(filterLines(lines, "verbose", "#4242").map((l) => l.tag)).toEqual(["flutter"]);
  });

  it("combines level and text", () => {
    expect(filterLines(lines, "warn", "boom")).toHaveLength(1);
    expect(filterLines(lines, "error", "bitmap")).toHaveLength(0);
  });
});

it("orders levels least severe first, with unknown last so it is never hidden", () => {
  expect(LEVELS[0]).toBe("verbose");
  expect(LEVELS.at(-1)).toBe("unknown");
  expect(LEVELS.indexOf("error")).toBeGreaterThan(LEVELS.indexOf("warn"));
  expect(LEVEL_CLASS.error).toBe("levelE");
});

it("shortens a logcat timestamp to the time of day", () => {
  expect(shortTime("11-04 12:52:39.123")).toBe("12:52:39.123");
});
