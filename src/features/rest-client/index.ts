import { lazyComponent } from "@/ui";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { registerActions } from "@/platform/actions";

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: "rest-client",
      title: "REST Client",
      icon: "file-http",
      iconText: "API",
      anchor: "right",
      order: 21,
      component: lazyComponent(() => import("./RestView").then((m) => m.RestView)),
    }),
    registerActions([
      {
        id: "rest.showToolWindow",
        title: "REST Client",
        category: "Tools",
        icon: "file-http",
        keywords: ["rest", "http", "request", "postman"],
        when: "projectOpen",
        run: () => toolWindowService().show("rest-client", true),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
