import { auxiliaryWindow } from "./platform/auxWindow";
import { installCommonWindowBoot } from "./windowBoot";

await installCommonWindowBoot();

// Auxiliary windows (`settings-<parent>`, `comparison-<parent>-<n>`, `diff-<parent>-<n>`,
// `deployment-<parent>`) load only their own module graph, without Workbench or CodeMirror
// when not needed.
const aux = auxiliaryWindow();

if (import.meta.env.VITE_OPENIDEA_PHONE) {
  // The phone app (`mobile/`): a client of a paired desktop.
  const { bootPhone } = await import("./phone/boot");
  bootPhone();
} else if (aux) {
  const { bootAuxiliaryWindow } = await import("./auxiliaryBoot");
  await bootAuxiliaryWindow(aux);
} else {
  const { bootWorkbenchWindow } = await import("./workbenchBoot");
  await bootWorkbenchWindow();
}
