/** The SVG source as typed, per file, for the preview beside it (redrawn shortly after typing stops). */
import { isSvgPath } from "../fileKinds";
import { createLiveText } from "../liveText";

const live = createLiveText("viewers.svgLive", isSvgPath);

export const useLiveSvg = live.useLive;
export const registerSvgLiveSource = live.register;
