import { afterEach, expect, it, vi } from "vitest";

const executeAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", async (original) => ({
  ...(await original<typeof import("./actions")>()),
  executeAction,
}));
import { buildToolRecovery } from "./buildToolRecovery";

afterEach(() => vi.clearAllMocks());

it.each([
  ["cannot start mvn: No such file or directory (os error 2)", "maven"],
  ["command not found: mvn", "maven"],
  ["command not found: /opt/apache maven/bin/mvn", "maven"],
  ["command not found: C:\\Maven\\bin\\mvn.cmd", "maven"],
  ["cannot start gradle: No such file or directory (os error 2)", "gradle"],
  ["command not found: gradle", "gradle"],
  ["command not found: C:\\Gradle\\bin\\gradle.bat", "gradle"],
  ["command not found: ./gradlew", "gradle"],
])("links missing build tool to its settings: %s", (message, tool) => {
  const result = buildToolRecovery(message);
  expect(result.body).toContain(`${tool === "maven" ? "Maven" : "Gradle"} could not be started`);
  expect(result.body).toContain(message);
  expect(result.actions).toHaveLength(1);
  result.actions[0]!.run();
  expect(executeAction).toHaveBeenCalledWith("file.settings", `build.${tool}`);
});

it("links the reported Gradle import rejection to the Gradle JVM picker and its JDK download", () => {
  const message =
    "Nov 9, 2026, 3:49:11 PM Can't use Java 27.0.1.0.3 and Gradle 9.7.1 to import Gradle project kotlin-gradle.";
  const result = buildToolRecovery(message);
  expect(result.body).toContain("Download JDK");
  expect(result.actions[0]!.label).toBe("Choose Gradle JVM");
  result.actions[0]!.run();
  expect(executeAction).toHaveBeenCalledWith("file.settings", "build.gradle");
});

it.each([
  "command not found: npm",
  "Maven tests failed",
  "Gradle build failed",
  "cannot start mvn: Permission denied (os error 13)",
])("leaves unrelated failures alone: %s", (message) => {
  expect(buildToolRecovery(message)).toEqual({ body: message, actions: [] });
});

it("links tsserver running out of memory to the language server settings", () => {
  const message =
    "tsserver stopped because it reached its memory limit and is restarted, so code intelligence may pause or miss results. Raise typescript.tsserver.maxTsServerMemory (in MB) in the server's Workspace Configuration.";
  const result = buildToolRecovery(message);
  expect(result.body).toBe(message);
  expect(result.actions.map((a) => a.label)).toEqual(["Language Servers…"]);
  result.actions[0]!.run();
  expect(executeAction).toHaveBeenCalledWith("file.settings", "languages.servers");
});
