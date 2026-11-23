/** The phone app: pairing and the project list first, then the workbench of the chosen project. */
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { useProject } from "@/platform/project";
import { hideSplash } from "@/platform/splash";
import type { ProjectInfo } from "@/platform/ipc";
import { PhoneGate } from "./PhoneGate";
import { installPhoneViewport } from "./viewport";
import { setCommandsRunElsewhere } from "@/platform/choosePath";

export function bootPhone(): void {
  installPhoneViewport();
  // File choosers browse the desktop's files, where every command runs.
  setCommandsRunElsewhere(true);
  if (import.meta.env.DEV) void import("./devEval").then((m) => m.installPhoneEval());
  const container = document.getElementById("root") as HTMLElement;
  const gate = ReactDOM.createRoot(container);
  const opened = async (project: ProjectInfo) => {
    gate.unmount();
    useProject.setState({ project, settings: project.settings, lightEdit: false });
    const { bootWorkbenchWindow } = await import("../workbenchBoot");
    await bootWorkbenchWindow();
    // A dropped link closes this phone's windows on the desktop: start over, which connects
    // again and goes back into the project (or says the computer can't be reached).
    void listen("phone://disconnected", () => location.reload());
  };
  gate.render(<PhoneGate onOpened={(p) => void opened(p)} />);
  hideSplash();
}
