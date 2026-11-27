import { describe, expect, it } from "vitest";
import { appendLoginOutput, parseDeviceCodePrompt } from "./deviceCode";

describe("parseDeviceCodePrompt", () => {
  it("parses Copilot CLI Ink output with SGR styling, OSC-8 links, and cursor-forward escapes", () => {
    const raw =
      "\x1b[?25l⠋ Waiting for authorization...\r\n" +
      "Enter\x1b[1Cone-time\x1b[1Ccode:\x1b[1C\x1b[1m\x1b[36mWDJB-MJHT\x1b[39m\x1b[22m\x1b[1Cat\x1b[1C" +
      "\x1b]8;;https://github.com/login/device\x07\x1b[4mhttps://github.com/login/device\x1b[24m\x1b]8;;\x07\r\n" +
      "Press any key to copy to clipboard and open browser...";
    expect(parseDeviceCodePrompt(raw)).toEqual({
      code: "WDJB-MJHT",
      url: "https://github.com/login/device",
      needsEnterToPoll: false,
    });
  });

  it("parses GitHub CLI device-code output across chunks and marks Press Enter to open", () => {
    let buffer = "";
    buffer = appendLoginOutput(buffer, "! First copy your one-time code: 9F4K-2L8P\r\n");
    expect(parseDeviceCodePrompt(buffer)).toBeNull();

    buffer = appendLoginOutput(buffer, "Press Enter to open https://github.com/login/device in your browser... ");
    expect(parseDeviceCodePrompt(buffer)).toEqual({
      code: "9F4K-2L8P",
      url: "https://github.com/login/device",
      needsEnterToPoll: true,
    });
  });

  it("parses Codex, Microsoft devicelogin, and RFC 8628 verification_uri_complete prompts", () => {
    expect(parseDeviceCodePrompt("│ Visit https://auth.openai.com/codex/device and enter code: ABCD-EFGH │")).toEqual({
      code: "ABCD-EFGH",
      url: "https://auth.openai.com/codex/device",
      needsEnterToPoll: false,
    });

    expect(
      parseDeviceCodePrompt(
        "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code K9P4M2X7Q to authenticate.",
      ),
    ).toEqual({
      code: "K9P4M2X7Q",
      url: "https://microsoft.com/devicelogin",
      needsEnterToPoll: false,
    });

    expect(
      parseDeviceCodePrompt("Open https://auth.example.com/activate?user_code=zx90-12ab to finish signing in."),
    ).toEqual({
      code: "ZX90-12AB",
      url: "https://auth.example.com/activate?user_code=zx90-12ab",
      needsEnterToPoll: false,
    });
  });

  it("updates to the newest code when an expired device code is re-issued", () => {
    const raw =
      "Enter one-time code: AAAA-1111 at https://github.com/login/device\n" +
      "Code expired. Enter one-time code: BBBB-2222 at https://github.com/login/device\n";
    expect(parseDeviceCodePrompt(raw)?.code).toBe("BBBB-2222");
  });

  it("ignores regular browser OAuth callback URLs with UUIDs and copyright year ranges", () => {
    expect(
      parseDeviceCodePrompt(
        "Copyright 2024-2026 Anthropic\n" +
          "Browser didn't open? Visit https://claude.ai/oauth/authorize?client_id=9D1C-4567-ABCD-EF01&state=XY12-3456",
      ),
    ).toBeNull();
  });
});
