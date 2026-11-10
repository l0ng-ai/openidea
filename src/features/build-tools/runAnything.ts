/**
 * Maven / Gradle command lines: what Execute Maven Goal / Execute Gradle Task
 * run, and the Run Anything provider for `mvn …` / `gradle …` lines (with goal
 * and task completion in the selected project).
 */
import type { BuildTool } from "@/platform/ipc";
import type { RunAnythingItem, RunAnythingProvider } from "@/workbench/contributions";
import {
  goalCompletions,
  gradleTaskConfig,
  gradleProjectForKey,
  mavenGoalConfig,
  parseGoalLine,
  parseTaskLine,
  taskCompletions,
} from "./model";
import { pushHistory, readHistory, runConfig, useBuild } from "./store";

const COMMANDS: Record<BuildTool, RegExp> = {
  maven: /^(\.\/)?mvnw?(\.cmd)?(\s|$)/,
  gradle: /^(\.\/)?gradlew?(\.bat)?(\s|$)/,
};
const WORD: Record<BuildTool, string> = { maven: "mvn", gradle: "gradle" };

/** The build tool a Run Anything line is for (`mvn clean`, `./gradlew build`), when the project has it. */
export function lineTool(line: string): BuildTool | null {
  const model = useBuild.getState().model;
  if (model?.maven && COMMANDS.maven.test(line)) return "maven";
  if (model?.gradle?.length && COMMANDS.gradle.test(line)) return "gradle";
  return null;
}

/** The project a line runs in: the given one, else the tool window's current one, else the first. */
function mavenProjectFor(key?: string | null) {
  const { model, current } = useBuild.getState();
  const projects = model?.maven?.projects ?? [];
  return projects.find((p) => p.pom === (key ?? current.maven)) ?? projects[0];
}

function gradleProjectFor(key?: string | null) {
  const { model, current } = useBuild.getState();
  return gradleProjectForKey(model?.gradle ?? [], key ?? current.gradle);
}

/** Runs goals / tasks typed for `tool` in a project; false when there is nothing to run. */
export function executeBuildLine(tool: BuildTool, text: string, projectKey?: string | null): boolean {
  const { model, settings } = useBuild.getState();
  if (tool === "maven") {
    const maven = model?.maven;
    const project = mavenProjectFor(projectKey);
    const goals = parseGoalLine(text);
    if (!maven || !project || !("pom" in project) || !goals.length) return false;
    runConfig(mavenGoalConfig(project, goals, maven, settings.maven), "run");
  } else {
    const selected = gradleProjectFor(projectKey);
    const tasks = parseTaskLine(text);
    if (!selected || !tasks.length) return false;
    runConfig(gradleTaskConfig(selected.build, selected.project, tasks, settings.gradle), "run");
  }
  pushHistory(tool, text.replace(COMMANDS[tool], "").trim());
  return true;
}

function completions(tool: BuildTool, rest: string) {
  if (tool === "maven") {
    const project = mavenProjectFor();
    return goalCompletions(rest, project && "pom" in project ? project.plugins : [], readHistory("maven"));
  }
  const selected = gradleProjectFor();
  return selected ? taskCompletions(rest, selected.build, readHistory("gradle")) : [];
}

export const buildToolsRunAnything: RunAnythingProvider = {
  id: "build-tools",
  group: "Build Tools",
  order: 20,
  items(query) {
    const tool = lineTool(query);
    if (!tool) return [];
    const head = /^\S+\s*/.exec(query)![0];
    return completions(tool, query.slice(head.length))
      .slice(0, 50)
      .map((c): RunAnythingItem => ({
        key: `${c.detail === "recent" ? "h" : "c"}:${c.line}`,
        label: `${WORD[tool]} ${c.line}`,
        detail: c.detail === "recent" || c.detail === "phase" ? undefined : c.detail,
        group:
          c.detail === "recent"
            ? { id: "recent", label: "Recent" }
            : { id: tool, label: tool === "maven" ? "Maven Goals" : "Gradle Tasks" },
        icon: tool === "maven" ? "file-maven" : "file-gradle",
        completion: `${WORD[tool]} ${c.detail === "recent" ? c.line : `${c.line} `}`,
        run: () => void executeBuildLine(tool, c.line),
      }));
  },
  execute(line) {
    const tool = lineTool(line);
    return !!tool && executeBuildLine(tool, line);
  },
};
