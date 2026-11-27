import { describe, expect, it } from "vitest";
import { csharpTargets } from "./csharpTargets";
import { targetConfig } from "./targets";
import { produceContext, produceFile, OPTIMISTIC } from "./producers";
import { dotnetTestType } from "./dotnetTypes";
import type { RunConfig } from "@/platform/ipc";

const config = (project: string): RunConfig => ({
  id: project,
  name: project,
  command: "dotnet",
  args: ["test", project],
  kind: "dotnet-test",
  params: { project, framework: "net9.0" },
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
});
const source = `namespace Demo.Tests;
public class Calculator {
 // [Fact] public void NotATest() {}
 [Xunit.Fact]
 public void Adds() { var s = "}"; }
 [Theory, InlineData(1)]
 public async Task Values(int n) { }
 public class Nested {
   [TestMethod] public void Child() {}
 }
}`;
describe("C# editor test targets", () => {
  it("tracks lines across multiline tokens and separate test classes", () => {
    const text = `namespace Demo {
/* a comment
   across lines */
class First {
  [Fact]
  void One(
  ) {}
}
class Second {
  [TestCase(
    1)]
  void Two(int value) {}
}
}`;
    expect(csharpTargets(text).map((t) => [t.line, t.path])).toEqual([
      [3, ["Demo.First"]],
      [5, ["Demo.First", "One"]],
      [8, ["Demo.Second"]],
      [11, ["Demo.Second", "Two"]],
    ]);
  });
  it("runs only methods declared in the chosen file", () => {
    const result = produceFile(
      { path: "/repo/two/Tests.cs", root: "/repo", content: source, configs: [config("/repo/two/Two.csproj")] },
      OPTIMISTIC,
    );
    expect(JSON.parse(result!.config!.params!.testMethods!)).toEqual([
      "Demo.Tests.Calculator.Adds",
      "Demo.Tests.Calculator.Values",
      "Demo.Tests.Calculator+Nested.Child",
    ]);
  });
  it("finds qualified and multiline attributes, nested types, and skips literals/comments", () => {
    expect(
      csharpTargets(source)
        .filter((t) => t.kind === "test")
        .map((t) => [t.line, t.path]),
    ).toEqual([
      [4, ["Demo.Tests.Calculator", "Adds"]],
      [6, ["Demo.Tests.Calculator", "Values"]],
      [8, ["Demo.Tests.Calculator+Nested", "Child"]],
    ]);
    expect(csharpTargets("namespace A { namespace B { class C { [Test] void T() {} } } }").at(-1)?.path).toEqual([
      "A.B.C",
      "T",
    ]);
  });
  it("selects the owning project when same-named tests exist in sibling projects", () => {
    const targets = csharpTargets(source);
    const configs = [config("one/One.csproj"), config("two/Two.csproj")];
    const result = targetConfig(
      targets.find((t) => t.name === "Adds")!,
      "two/Tests.cs",
      configs,
      source,
    )!;
    expect(result.params?.project).toBe("two/Two.csproj");
    expect(dotnetTestType.commandLine(result.params!)?.args).toContain("FullyQualifiedName=Demo.Tests.Calculator.Adds");
  });
  it("normalizes absolute workspace project paths for caret/gutter launch", () => {
    const result = produceContext(
      {
        path: "/repo/two/Tests.cs",
        root: "/repo",
        content: source,
        line: 4,
        configs: [config("/repo/one/One.csproj"), config("/repo/two/Two.csproj")],
      },
      OPTIMISTIC,
    );
    expect(result?.config?.params?.project).toBe("two/Two.csproj");
  });
});
