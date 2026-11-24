import { BUILD_GROUP } from "./execution";
import { lazyPage } from "./lazyPage";
import type { PageSpec } from "./spec";

const DeploymentServersEditor = lazyPage("build.deployment", () =>
  import("./DeploymentBody").then((m) => m.DeploymentServersEditor),
);
const ExcludeNamesRow = lazyPage("build.deployment.options", () =>
  import("./DeploymentBody").then((m) => m.ExcludeNamesRow),
);

export const DEPLOYMENT_PAGES: PageSpec[] = [
  {
    id: "build.deployment",
    title: "Deployment",
    group: BUILD_GROUP,
    order: 365,
    projectScope: true,
    defaultScope: "project",
    keywords: [
      "local",
      "mounted",
      "sftp",
      "ftp",
      "ftps",
      "ssh",
      "server",
      "upload",
      "remote host",
      "mappings",
      "web server",
      "deploy",
    ],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Deployment servers",
            keywords: [
              "Connection",
              "Mappings",
              "Excluded Paths",
              "Root path",
              "Web server URL",
              "SSH configuration",
              "FTP",
              "Passive mode",
              "Password",
              "Save password",
              "Test Connection",
              "Use as Default",
              "Server Group",
              "Local path",
              "Deployment path",
              "Web path",
            ],
            component: DeploymentServersEditor,
          },
        ],
      },
    ],
  },
  {
    id: "build.deployment.options",
    title: "Options",
    order: 0,
    projectScope: true,
    defaultScope: "project",
    keywords: ["deployment", "upload", "exclude", "timestamps", "automatic upload", "sftp"],
    sections: [
      {
        options: [
          {
            kind: "custom",
            label: "Exclude items by name",
            keywords: ["exclude"],
            component: ExcludeNamesRow,
          },
          {
            kind: "select",
            key: "deployment.autoUpload",
            label: "Upload changed files automatically to the default server",
            options: [
              { value: "never", label: "Never" },
              { value: "onExplicitSave", label: "On explicit save action" },
              { value: "always", label: "Always" },
            ],
          },
          { kind: "toggle", key: "deployment.deleteRemote", label: "Delete remote files when local are deleted" },
          { kind: "toggle", key: "deployment.preserveTimestamps", label: "Preserve files timestamps" },
        ],
      },
    ],
  },
];
