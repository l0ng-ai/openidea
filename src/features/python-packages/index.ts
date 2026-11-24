/** Python Packages: the project interpreter's packages, with PyPI lookup, in a tool window. */
import { registerActions } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";

const ID = "pythonPackages";

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: ID,
      title: "Python Packages",
      icon: "package",
      anchor: "bottom",
      // Listed under the stripe's "…" until first opened: most projects are not Python ones.
      stripe: "onUse",
      order: 28,
      component: lazyComponent(() => import("./PackagesView").then((m) => m.PackagesView)),
    }),
    registerActions([
      {
        id: "python.packages.show",
        title: "Python Packages",
        category: "Tools",
        when: "projectOpen",
        run: () => toolWindowService().show(ID, true),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
