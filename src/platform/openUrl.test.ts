import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn(async (_url: string) => {});

vi.mock("./ipc", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { installMiddleClickLinks, openExternalUrl } from "./openUrl";

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

describe("middle click on a link", () => {
  beforeEach(() => openUrl.mockClear());

  const middleClick = (target: Element) => {
    const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it("opens a web link in the browser instead of letting the webview navigate (#4992)", async () => {
    const off = installMiddleClickLinks();
    document.body.innerHTML = '<p><a href="https://example.com/pr/1"><code>#1</code></a><a href="/local">x</a></p>';
    const event = middleClick(document.querySelector("code")!);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/pr/1"));

    // A link into the app itself is not handed to the browser, nor followed.
    expect(middleClick(document.querySelector('a[href="/local"]')!).defaultPrevented).toBe(true);
    // Left clicks and other targets are left alone.
    const left = new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true });
    document.querySelector("code")!.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
    expect(middleClick(document.querySelector("p")!).defaultPrevented).toBe(false);
    off();
    expect(middleClick(document.querySelector("code")!).defaultPrevented).toBe(false);
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
