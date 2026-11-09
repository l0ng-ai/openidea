import { afterEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { activateWorkbench } from "./activate";
import { notify, useNotifications } from "./notificationStore";

afterEach(() => {
  useNotifications.setState({ items: [] });
  useProject.setState({ project: null, lightEdit: false });
});

describe("notifications across project changes", () => {
  it("keeps app-level update notifications and drops project ones", () => {
    useProject.setState({
      project: { root: "/p", name: "p", trusted: true, isGit: false, settings: {} } as never,
    });
    const dispose = activateWorkbench();
    try {
      notify({ level: "info", title: "Downloading OpenIDEA 0.1.35", key: "app.update", sticky: true });
      notify({ level: "info", title: "Git refresh failed", group: "vcs" });
      useProject.setState({ project: null });
      expect(useNotifications.getState().items.map((n) => n.title)).toEqual(["Downloading OpenIDEA 0.1.35"]);
    } finally {
      dispose();
    }
  });
});
