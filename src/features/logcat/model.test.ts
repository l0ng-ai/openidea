import { describe, expect, it } from "vitest";
import type { LogcatLine } from "@/platform/ipc";
import { LEVEL_CLASS, LEVELS, filterLines, shortTime } from "./model";
import { compileQuery } from "./query";

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

describe("filter expressions", () => {
  const tags = (query: string) => filterLines(lines, "verbose", query).map((l) => l.tag);

  it("drops what a negated term matches", () => {
    expect(tags("-message:boom")).toEqual(["chatty", "ActivityManager", "Glide", ""]);
    expect(tags("-tag:glide -tag:flutter")).toEqual(["chatty", "ActivityManager", ""]);
  });

  it("ands adjacent terms and or-s them with |", () => {
    expect(tags("tag:glide message:bitmap")).toEqual(["Glide"]);
    expect(tags("tag:glide|tag:flutter")).toEqual(["Glide", "flutter"]);
    expect(tags("tag:glide | tag:flutter")).toEqual(["Glide", "flutter"]);
  });

  it("groups, so a negation can apply to either term", () => {
    expect(tags("(tag:glide|tag:flutter) -level:error")).toEqual(["Glide"]);
    expect(tags("-(tag:glide|tag:flutter)")).toEqual(["chatty", "ActivityManager", ""]);
  });

  it("matches a level by name, letter or list", () => {
    expect(tags("level:error")).toEqual(["flutter"]);
    expect(tags("level:w,e")).toEqual(["Glide", "flutter"]);
    expect(tags("level:ERROR")).toEqual(["flutter"]);
  });

  it("matches pid and tid, and still #pid", () => {
    expect(tags("pid:4242")).toEqual(["flutter"]);
    expect(tags("pid:4243")).toEqual(["flutter"]);
    expect(tags("#4242")).toEqual(["flutter"]);
  });

  it("takes a regular expression after ~", () => {
    expect(tags("message~:^Displayed")).toEqual(["ActivityManager"]);
    expect(tags("tag~:^ACTIVITY")).toEqual(["ActivityManager"]);
  });

  it("reads a quoted value, including an empty one", () => {
    expect(tags('message:"IllegalState boom"')).toEqual([]);
    expect(tags("message:'IllegalStateException: boom'")).toEqual(["flutter"]);
    expect(tags('tag:""')).toEqual([""]);
  });

  it("treats an unknown key as plain text", () => {
    expect(tags("package:com.example")).toEqual([]);
  });

  it("ignores an invalid query and says why", () => {
    expect(compileQuery("tag:((").error).toBeTruthy();
    expect(compileQuery("message~:(").error).toBeTruthy();
    expect(compileQuery("").error).toBeNull();
    expect(tags("tag:((")).toHaveLength(5);
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
