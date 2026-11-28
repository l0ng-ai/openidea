/**
 * Extracts OAuth 2.0 device-authorization URLs and one-time user codes (`ABCD-1234`, etc.)
 * from interactive sign-in PTY output (`copilot login`, `gh auth login`, `codex login`, …).
 */
import { isOpenable } from "./openUrl";

const MAX_BUFFER_CHARS = 16_384;
// oxlint-disable-next-line no-control-regex
const OSC_HYPERLINK_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex
const OSC_OTHER_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[[0-9;:]*m/g;
// oxlint-disable-next-line no-control-regex
const CSI_NON_SGR_RE = /\x1b\[[0-9;?]*[@-ln-zA-Z~]/g;
// oxlint-disable-next-line no-control-regex
const ESC_SINGLE_RE = /\x1b[@-_]/g;
// oxlint-disable-next-line no-control-regex
const CONTROL_OR_BOX_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f│┃╭╮╯╰┌┐└┘├┤┬┴┼─━═║╔╗╚╝]/g;

const HTTPS_URL_RE = /https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
const TRAILING_SIMPLE_PUNCT_RE = /[.,;:!?'"]+$/;
const DEVICE_PATH_RE = /(?:^|\/)(?:device|devicelogin|activate|device-login|user-code)(?:\/|$)/i;
const EXPLICIT_CODE_CUE_RE = /(?:one-time|device|verification)\s+code/i;
const LABELED_CODE_RE =
  /(?:[Oo]ne-time|ONE-TIME|[Dd]evice|DEVICE|[Vv]erification|VERIFICATION|[Uu]ser|USER|(?:[Ee]nter|ENTER)(?:\s+(?:[Tt]he|THE))?)\s+(?:[Cc]ode|CODE)(?:\s+(?:[Ii]s|IS))?\s*[:：]?\s*([A-Z0-9]{4,6}-[A-Z0-9]{3,6}|[A-Z0-9]{8,9})(?![A-Za-z0-9-])/g;

function trimTrailingUrlPunct(raw: string): string {
  let out = raw;
  for (;;) {
    const trimmed = out.replace(TRAILING_SIMPLE_PUNCT_RE, "");
    if (trimmed !== out) {
      out = trimmed;
      continue;
    }
    if (out.endsWith(")") && out.split(")").length > out.split("(").length) {
      out = out.slice(0, -1);
      continue;
    }
    if (out.endsWith("]") && out.split("]").length > out.split("[").length) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}
const HYPHENATED_CODE_RE = /(?:^|[^A-Za-z0-9-])([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?![A-Za-z0-9-])/g;
const YEAR_RANGE_RE = /^(?:19|20)\d{2}-(?:19|20)\d{2}$/;
const COMPLETE_URI_CODE_RE = /^[A-Za-z0-9]{4,8}(?:-[A-Za-z0-9]{3,8})?$/;
const PRESS_ENTER_TO_OPEN_RE = /\bPress Enter to open\b/i;

export interface DeviceCodePrompt {
  code: string;
  url: string;
  /** True when the CLI pauses at "Press Enter to open …" before starting its token poll (`gh auth login`). */
  needsEnterToPoll: boolean;
}

export function appendLoginOutput(previous: string, chunk: string): string {
  if (!chunk) return previous;
  const next = previous + chunk;
  return next.length > MAX_BUFFER_CHARS ? next.slice(next.length - MAX_BUFFER_CHARS) : next;
}

function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(OSC_HYPERLINK_RE, (_match, uri: string) => (uri ? ` ${uri} ` : ""))
    .replace(OSC_OTHER_RE, "")
    .replace(SGR_RE, "")
    .replace(CSI_NON_SGR_RE, " ")
    .replace(ESC_SINGLE_RE, " ")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_OR_BOX_RE, " ");
}

export function parseDeviceCodePrompt(rawOutput: string): DeviceCodePrompt | null {
  if (!rawOutput) return null;
  const cleaned = cleanTerminalOutput(rawOutput);

  let latestDeviceUrl: string | null = null;
  let fallbackHttpsUrl: string | null = null;
  let completeUriPrompt: { url: string; code: string; index: number } | null = null;

  for (const match of cleaned.matchAll(HTTPS_URL_RE)) {
    const candidate = trimTrailingUrlPunct(match[0]);
    if (!isOpenable(candidate)) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    fallbackHttpsUrl = candidate;
    const queryCode = parsed.searchParams.get("user_code")?.trim();
    if (queryCode && COMPLETE_URI_CODE_RE.test(queryCode) && !YEAR_RANGE_RE.test(queryCode)) {
      completeUriPrompt = { url: candidate, code: queryCode.toUpperCase(), index: match.index ?? 0 };
    }
    if (DEVICE_PATH_RE.test(parsed.pathname)) {
      latestDeviceUrl = candidate;
    }
  }

  const textWithoutUrls = cleaned.replace(HTTPS_URL_RE, " ");

  let latestCode: { code: string; index: number } | null = null;
  for (const match of textWithoutUrls.matchAll(LABELED_CODE_RE)) {
    const code = match[1];
    if (code && !YEAR_RANGE_RE.test(code)) {
      latestCode = { code, index: match.index ?? 0 };
    }
  }

  const targetUrl = latestDeviceUrl ?? (EXPLICIT_CODE_CUE_RE.test(textWithoutUrls) ? fallbackHttpsUrl : null);

  if (!latestCode && latestDeviceUrl) {
    for (const match of textWithoutUrls.matchAll(HYPHENATED_CODE_RE)) {
      const code = match[1];
      if (code && !YEAR_RANGE_RE.test(code)) {
        latestCode = { code, index: match.index ?? 0 };
      }
    }
  }

  if (completeUriPrompt && (!latestCode || completeUriPrompt.index >= latestCode.index)) {
    const tail = cleaned.slice(completeUriPrompt.index);
    return {
      code: completeUriPrompt.code,
      url: completeUriPrompt.url,
      needsEnterToPoll: PRESS_ENTER_TO_OPEN_RE.test(tail),
    };
  }

  if (!targetUrl || !latestCode) return null;
  const tail = cleaned.slice(latestCode.index);
  return {
    code: latestCode.code,
    url: targetUrl,
    needsEnterToPoll: PRESS_ENTER_TO_OPEN_RE.test(tail),
  };
}
