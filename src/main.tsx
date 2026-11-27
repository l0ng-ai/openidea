import { auxiliaryWindow } from "./platform/auxWindow";
import { initWebRuntime } from "./platform/webBridge";
import { installCommonWindowBoot } from "./windowBoot";

await initWebRuntime();
await installCommonWindowBoot();

// Auxiliary windows (`settings-<parent>`, `comparison-<parent>-<n>`, `diff-<parent>-<n>`,
// `deployment-<parent>`, `new-project-<parent>`, `clone-<parent>`, `connect-<parent>`) load only their own module graph, without Workbench or CodeMirror
// when not needed.
const aux = auxiliaryWindow();

if (aux) {
  const { bootAuxiliaryWindow } = await import("./auxiliaryBoot");
  await bootAuxiliaryWindow(aux);
} else {
  const { bootWorkbenchWindow } = await import("./workbenchBoot");
  await bootWorkbenchWindow();
}
