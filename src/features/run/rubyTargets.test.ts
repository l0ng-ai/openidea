import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { detectRunTargets, targetConfig, targetLanguage } from "./targets";

const SRC = `require_relative "../test_helper"

module Outer
  class InnerTest < Minitest::Test
    def test_one = assert true

    def test_two?
      assert true
    end

    def helper = 1
  end

  class Helper
    def test_not_a_test_class = 1
  end
end

class TopTest < ActiveSupport::TestCase
  test "does a thing" do
    assert true
  end
end

module Empty
  class Plain
  end
end
`;

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: "bundle",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
  ...over,
});

describe("Ruby run targets", () => {
  const targets = detectRunTargets(SRC, "test/unit/test_outer.rb");
  const find = (name: string) => targets.find((t) => t.name === name)!;

  it("is a target language", () => expect(targetLanguage("a.rb")).toBe("ruby"));

  it("finds test classes, the modules holding them, and their test methods", () => {
    expect(targets.map((t) => [t.kind, t.name, t.line])).toEqual([
      ["suite", "Outer", 2],
      ["suite", "Outer::InnerTest", 3],
      ["test", "Outer::InnerTest#test_one", 4],
      ["test", "Outer::InnerTest#test_two?", 6],
      ["suite", "TopTest", 18],
      ["test", "TopTest#test_does_a_thing", 19],
    ]);
    expect(find("Outer").rubyModule).toBe(true);
    expect(find("Outer::InnerTest").path).toEqual(["Outer::InnerTest"]);
    expect(find("Outer::InnerTest#test_one").path).toEqual(["Outer::InnerTest", "test_one"]);
  });

  it("leaves modules without test classes, non-test classes and non-test files alone", () => {
    expect(targets.some((t) => t.name === "Empty" || t.name.includes("Helper"))).toBe(false);
    expect(detectRunTargets(SRC, "lib/outer.rb")).toEqual([]);
    expect(detectRunTargets(SRC, "spec/outer_spec.rb")).toEqual([]);
  });

  describe("run configurations", () => {
    const rake = cfg({ id: "rake:test", kind: "rake", args: ["exec", "rake", "test"] });
    const minitest = cfg({ id: "minitest", kind: "ruby", command: "ruby", args: ["-Ilib", "-e", "RUNNER", "test"] });
    const run = (t: string, base: RunConfig) => targetConfig(find(t), "test/unit/test_outer.rb", [base], SRC)?.args;

    it("one test by its exact name, through rake and through the Minitest runner", () => {
      expect(run("Outer::InnerTest#test_one", rake)).toEqual([
        "exec",
        "rake",
        "test",
        "TEST=test/unit/test_outer.rb",
        "TESTOPTS=--name=Outer::InnerTest#test_one",
      ]);
      expect(run("Outer::InnerTest#test_one", minitest)).toEqual([
        "-Ilib",
        "-e",
        "RUNNER",
        "test/unit/test_outer.rb",
        "--name=Outer::InnerTest#test_one",
      ]);
    });

    it("a class runs its own tests, a module the tests of the classes inside it", () => {
      expect(run("Outer::InnerTest", minitest)!.at(-1)).toBe("--name=/^Outer::InnerTest#/");
      expect(run("Outer", minitest)!.at(-1)).toBe("--name=/^Outer::/");
      expect(run("Outer", rake)!.at(-1)).toBe("TESTOPTS=--name=/^Outer::/");
    });
  });
});
