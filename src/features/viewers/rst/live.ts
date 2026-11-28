/** The reStructuredText source as typed, per file, for the preview beside it. */
import { isRstPath } from "../fileKinds";
import { createLiveText } from "../liveText";

const live = createLiveText("viewers.rstLive", isRstPath);

export const useLiveRst = live.useLive;
export const registerRstLiveSource = live.register;
