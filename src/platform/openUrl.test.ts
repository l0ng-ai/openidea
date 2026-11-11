import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn(async (_url: string) => {});

vi.mock("./ipc", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { openExternalUrl } from "./openUrl";

describe("openExternalUrl", () => {
  beforeEach(() => openUrl.mockClear());

  it.each(["https://example.com/a?b=1", "http://localhost:3000/", "mailto:a@b.co"])("opens %s", async (url) => {
    await openExternalUrl(url);
    expect(openUrl).toHaveBeenCalledWith(url);
  });

  it.each([
    "file:///C:/Windows/win.ini",
    "ms-msdt:/id x",
    "search-ms:query=x",
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.example",
    " https://example.com",
    "example.com",
    "",
  ])("refuses %j", async (url) => {
    await openExternalUrl(url);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
