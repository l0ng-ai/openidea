import { BUILD_GROUP } from "./execution";
import { lazyPage } from "./lazyPage";
import type { PageSpec } from "./spec";

export { parentPath, splitList } from "./runTargetsPaths";

const RunTargetsEditor = lazyPage("build.runTargets", () => import("./RunTargetsBody").then((m) => m.RunTargetsEditor));

export const RUN_TARGET_PAGES: PageSpec[] = [
  {
    id: "build.runTargets",
    title: "Run Targets",
    group: BUILD_GROUP,
    order: 364,
    projectScope: true,
    keywords: ["ssh", "remote", "target", "run on", "interpreter", "upload", "sync", "docker", "compose", "container"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Run Targets",
            keywords: [
              "SSH configuration",
              "Project folder on target",
              "Upload changed project files before each run",
              "Python interpreter",
              "Node.js interpreter",
              "Java executable",
              "Docker connection",
              "Image",
              "Compose files",
              "Service",
              "Container folder",
              "Published ports",
              "Run options",
            ],
            component: RunTargetsEditor,
          },
        ],
      },
    ],
  },
];
