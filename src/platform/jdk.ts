/**
 * Download JDK (`jdk_download*` commands), shared by the JDK pickers in Settings
 * and the "Download JDK N" fixes offered where a launch or sync lacks a JDK.
 * The one-click fix is the `java.downloadJdk` action (features/tools).
 */
import { Channel } from "@tauri-apps/api/core";
import { executeAction, getAction } from "./actions";
import { call, commands, nextRequestId, type InstallEvent, type Sdk } from "./ipc";

export const DOWNLOAD_JDK_ACTION = "java.downloadJdk";
export const TEMURIN = "temurin";

export interface DownloadJdkArgs {
  /** Java feature version, e.g. 25. */
  version: number;
  /** Run jdtls on it: chosen as the language server JDK unless Auto already picks it. */
  languageServer?: boolean;
}

export interface JdkRequirement {
  version: number;
  /** The JDK runs the Java language server (jdtls), not the project. */
  languageServer: boolean;
}

/**
 * The JDK a launch / sync error asks for: the backend's messages say
 * "jdtls needs JDK 25 or newer" / "it needs JDK 21 or newer".
 */
export function requiredJdk(message: string | null | undefined): JdkRequirement | null {
  const m = /needs JDK (\d+) or newer/.exec(message ?? "");
  if (!m) return null;
  return { version: Number(m[1]), languageServer: /\bjdtls\b|language server JDK/i.test(message ?? "") };
}

/** "Download JDK N" notification / banner actions for `message`; none when it names no JDK or nothing can download. */
export function downloadJdkActions(message: string | null | undefined): Array<{ label: string; run: () => void }> {
  const need = requiredJdk(message);
  if (!need || !getAction(DOWNLOAD_JDK_ACTION)) return [];
  const args: DownloadJdkArgs = { version: need.version, languageServer: need.languageServer };
  return [{ label: `Download JDK ${need.version}`, run: () => void executeAction(DOWNLOAD_JDK_ACTION, args) }];
}

export function isDownloadJdkArgs(arg: unknown): arg is DownloadJdkArgs {
  return !!arg && typeof arg === "object" && typeof (arg as { version?: unknown }).version === "number";
}

export interface JdkDownload {
  promise: Promise<Sdk>;
  cancel: () => void;
}

/** Downloads the latest `vendor` JDK `version` into `location` (null: the IDE's JDK folder). */
export function downloadJdk(
  vendor: string,
  version: number,
  location: string | null,
  onEvent: (e: InstallEvent) => void,
): JdkDownload {
  const request = nextRequestId();
  const channel = new Channel<InstallEvent>();
  channel.onmessage = onEvent;
  return {
    promise: call(commands.jdkDownload(vendor, version, location, request, channel)),
    cancel: () => void commands.cancelRequest(request).catch(() => {}),
  };
}
