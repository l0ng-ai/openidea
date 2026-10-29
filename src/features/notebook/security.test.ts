import { describe, expect, it } from "vitest";
import { markdownRoot, resolveMarkdownAttachments, sanitizedSvgUrl, staticOutputDocument } from "./security";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("static notebook output sanitization", () => {
  it("retains table content while removing executable, navigation and external-resource surfaces", () => {
    const document = parse(
      staticOutputDocument(`
      <meta http-equiv="refresh" content="0;url=https://attacker.invalid">
      <base href="https://attacker.invalid"><script>window.__TAURI_INTERNALS__.invoke('x')</script>
      <form action="https://attacker.invalid"><input name="secret"><button>submit</button></form>
      <iframe src="https://attacker.invalid"></iframe><object data="https://attacker.invalid"></object>
      <a href="https://attacker.invalid" target="_top" ping="https://attacker.invalid">link</a>
      <img src="https://attacker.invalid/a.png" srcset="https://attacker.invalid/b.png 2x" onerror="alert(1)">
      <div style="background-image:image-set('https://attacker.invalid/x')">safe text</div>
      <table><thead><tr><th>name</th><th>value</th></tr></thead><tbody><tr><td>alpha</td><td>42</td></tr></tbody></table>
    `),
    );
    expect(document.querySelector("tbody tr")?.textContent).toBe("alpha42");
    expect(document.querySelector("script,base,form,input,button,iframe,object")).toBeNull();
    expect(document.querySelector("meta[http-equiv=refresh]")).toBeNull();
    expect(document.querySelector("[href],[target],[srcset],[onerror],[ping]")).toBeNull();
    expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(document.querySelector("body div")?.hasAttribute("style")).toBe(false);
  });

  it("retains safe SVG chart paint, local definitions and raster images but removes active/external SVG", () => {
    const url = sanitizedSvgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <script>alert(1)</script><foreignObject><div>host markup</div></foreignObject>
      <defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs>
      <path id="chart" d="M0 0L10 10" style="fill:none;stroke:#123456;stroke-width:2" onclick="alert(1)"/>
      <rect fill="url(#paint)" width="10" height="10"/>
      <use id="local-marker" href="#chart"/>
      <use href="https://attacker.invalid/a.svg#x"/><image href="data:image/png;base64,aGVsbG8="/>
      <path id="external" fill="url(https://attacker.invalid/paint)"/>
      <animate attributeName="href" to="https://attacker.invalid"/>
    </svg>`);
    const xml = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    const document = new DOMParser().parseFromString(xml, "image/svg+xml");
    expect(document.querySelector("script,foreignObject,animate,style")).toBeNull();
    expect(document.querySelector('[href^="https:"],[href^="http:"]')).toBeNull();
    expect(document.querySelector("#chart")?.getAttribute("stroke")).toBe("#123456");
    expect(document.querySelector("#chart")?.getAttribute("fill")).toBe("none");
    expect(document.querySelector("rect")?.getAttribute("fill")).toBe("url(#paint)");
    expect(document.querySelector("#local-marker")?.getAttribute("href")).toBe("#chart");
    expect(document.querySelector("#external")?.hasAttribute("fill")).toBe(false);
    expect(document.querySelector("image")?.getAttribute("href")).toBe("data:image/png;base64,aGVsbG8=");
    expect(document.querySelector("[onclick],[style]")).toBeNull();
  });

  it("resolves only embedded image attachments and makes Markdown file links editor-controlled", () => {
    const root = resolveMarkdownAttachments(
      markdownRoot(
        `![chart](attachment:chart.png)\n\n![remote](https://attacker.invalid/a.png)\n\n[local](./other.py#L8)\n\n<script>alert(1)</script><div style="position:fixed">text</div>`,
      ),
      {
        "chart.png": { "image/png": "aGVsbG8=" },
      },
    );
    const images = root.querySelectorAll("img");
    expect(images[0]?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(images[1]?.hasAttribute("src")).toBe(false);
    const link = root.querySelector("a");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(link?.getAttribute("data-notebook-href")).toBe("./other.py#L8");
    expect(root.querySelector("script,[style]")).toBeNull();
  });
});
