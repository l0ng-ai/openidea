/** Plots tool window: matplotlib figures of Python runs (`IdeEvent::PlotAdded`, see `ide-run/src/plots`). */
import { onIdeEvent } from "@/platform/ipc";
import { lazyComponent } from "@/ui";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { addPlot } from "./store";

const ID = "plots";

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: ID,
      title: "Plots",
      icon: "image",
      anchor: "right",
      // Listed under the stripe's "…" until the first figure arrives.
      stripe: "onUse",
      sessionContent: true,
      component: lazyComponent(() => import("./PlotsView").then((m) => m.PlotsView)),
      headerActions: lazyComponent(() => import("./PlotsView").then((m) => m.PlotsHeaderActions)),
    }),
    // PyCharm brings the window up, without focus, when a figure arrives.
    onIdeEvent("plotAdded", (e) => {
      if (addPlot(e.path)) toolWindowService().show(ID, false);
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
