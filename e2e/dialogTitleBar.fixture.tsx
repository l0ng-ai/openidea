import "../src/styles/global.css";
import { createRoot } from "react-dom/client";
import { usePlatform } from "../src/platform/platformInfo";
import { Dialog } from "../src/ui/Dialog";

usePlatform.setState({ os: "macos", overlayTitleBar: true });
document.body.innerHTML = `<div id="root"></div>`;
createRoot(document.querySelector("#root")!).render(
  <Dialog open title="Push Commits to origin/main" onClose={() => {}} width={860} maxHeight={720} resizable="both">
    <div style={{ height: 2000 }} />
  </Dialog>,
);
