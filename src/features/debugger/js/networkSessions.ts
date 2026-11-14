import { useDebug } from "../state";
import { forgetNetwork, useJsNetwork } from "./network";

/**
 * Drops a session's requests when the session is removed. (Recording itself starts in the
 * backend with the page session, so that the page's load is in the list.) Returns the
 * unsubscribe function.
 */
export function watchNetworkSessions(): () => void {
  return useDebug.subscribe((s) => {
    for (const id of Object.keys(useJsNetwork.getState().rows)) if (!s.sessions[+id]) forgetNetwork(+id);
  });
}
