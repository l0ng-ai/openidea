import type { AuxKind } from "./platform/auxWindow";
import { mountWindowRoot } from "./windowBoot";
import { activateSecondaryWindow } from "./workbench/activateSecondary";

export async function bootAuxiliaryWindow(aux: { kind: AuxKind; parent: string }): Promise<void> {
  activateSecondaryWindow();
  switch (aux.kind) {
    case "settings": {
      const { bootSettingsWindow } = await import("./settingsWindowBoot");
      mountWindowRoot(bootSettingsWindow(aux.parent));
      return;
    }
    case "comparison": {
      const { bootComparisonWindow } = await import("./comparisonWindowBoot");
      mountWindowRoot(bootComparisonWindow(aux.parent));
      return;
    }
    case "diff": {
      const { bootDiffWindow } = await import("./diffWindowBoot");
      mountWindowRoot(bootDiffWindow(aux.parent));
      return;
    }
    case "deployment": {
      const { bootDeploymentWindow } = await import("./deploymentWindowBoot");
      mountWindowRoot(bootDeploymentWindow(aux.parent));
      return;
    }
  }
}
