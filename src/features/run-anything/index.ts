/**
 * Run Anything (⌃⌃, IDEA's RunAnything): one popup to run a shell command in
 * the project directory, a run configuration or a build tool goal. Features
 * add entries with `registerRunAnythingProvider`.
 */
import { registerActions } from "@/platform/actions";
import { registerOverlay } from "@/workbench/contributions";
import { RunAnythingHost, showRunAnything } from "./RunAnything";

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "runAnything.popup", component: RunAnythingHost }),
    registerActions([
      {
        id: "runAnything.show",
        title: "Run Anything…",
        category: "Run",
        icon: "run-anything",
        keywords: ["command", "shell", "execute", "npm", "mvn", "gradle"],
        when: "projectOpen",
        run: ({ arg }) => showRunAnything(arg),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
