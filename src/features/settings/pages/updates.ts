import { lazyPage } from "./lazyPage";
import type { PageSpec } from "./spec";

const UpdateStatusRows = lazyPage("general.updates", () => import("./UpdatesBody").then((m) => m.UpdateStatusRows));

export const UPDATES_PAGE: PageSpec = {
  id: "general.updates",
  title: "Updates",
  order: 3,
  keywords: ["update", "upgrade", "version", "automatic", "GitHub", "CNB"],
  sections: [
    {
      options: [
        {
          kind: "custom",
          label: "Current version",
          keywords: ["Last checked", "Check Now"],
          component: UpdateStatusRows,
        },
        {
          kind: "toggle",
          key: "general.autoCheckUpdates",
          label: "Check for updates automatically",
          hint: "At startup and every 4 hours while OpenIDEA runs. Each new version is announced once per session.",
        },
        {
          kind: "toggle",
          key: "general.showWhatsNewAfterUpdate",
          label: "Show What's New after an update",
          hint: "Opens a page with the release notes when a new version starts. Help › What's New opens it any time.",
        },
        {
          kind: "select",
          key: "general.updateSource",
          label: "Update source",
          hint: "Where updates are downloaded from. If it can't be reached, the other source is tried.",
          options: [
            { value: "auto", label: "Automatic" },
            { value: "github", label: "GitHub" },
            { value: "cnb", label: "CNB (China mirror)" },
          ],
        },
      ],
    },
  ],
};
