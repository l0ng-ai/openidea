import { useSyncExternalStore } from "react";
import { detectDesktopPlatform } from "../lib/downloads.mjs";
import { publicAsset } from "../lib/paths.mjs";

const subscribe = () => () => undefined;
const serverPlatform = () => null;
const browserPlatform = () => detectDesktopPlatform(navigator.userAgent, navigator.maxTouchPoints);

export function useDownloadPath() {
  const platform = useSyncExternalStore(subscribe, browserPlatform, serverPlatform);
  return publicAsset(platform ? `download/${platform}/` : "download/", import.meta.env.BASE_URL);
}
