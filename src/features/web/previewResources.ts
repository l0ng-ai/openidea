const LOADABLE_LINKS = new Set(["stylesheet", "icon", "manifest", "preload", "prefetch", "modulepreload"]);

function relativePath(pathname: string): string | null {
  try {
    const segments = pathname.split("/").map(decodeURIComponent);
    return segments.some((part) => /[/\\:\0]/.test(part)) ? null : segments.filter(Boolean).join("/");
  } catch {
    return null;
  }
}

/** Local resources referenced by a page inside the built-in server's URL namespace. */
export function previewResources(path: string, url: string, html: string): Set<string> {
  const resources = new Set([path]);
  const page = new URL(url);
  // The first two URL segments are the server token and the served directory's key.
  const prefix = page.pathname.split("/").slice(0, 3).join("/") + "/";
  const pagePath = relativePath(page.pathname.slice(prefix.length));
  if (!pagePath || !path.endsWith(`/${pagePath}`)) return resources;
  const directory = path.slice(0, -pagePath.length);

  const template = document.createElement("template");
  template.innerHTML = html;
  const doc = template.content;
  let base = page;
  try {
    base = new URL(doc.querySelector("base[href]")?.getAttribute("href") ?? "", page);
  } catch {
    // Invalid base URLs leave relative resources on the page URL.
  }

  const add = (reference: string | null) => {
    if (!reference?.trim() || reference.trimStart().startsWith("#")) return;
    try {
      const resource = new URL(reference, base);
      if (resource.origin !== page.origin || !resource.pathname.startsWith(prefix)) return;
      const relative = relativePath(resource.pathname.slice(prefix.length));
      if (relative) resources.add(directory + relative);
    } catch {
      // The browser ignores invalid resource URLs too.
    }
  };
  for (const element of doc.querySelectorAll("[src]")) add(element.getAttribute("src"));
  for (const element of doc.querySelectorAll("link[href]")) {
    if (
      element
        .getAttribute("rel")
        ?.toLowerCase()
        .split(/\s+/)
        .some((rel) => LOADABLE_LINKS.has(rel))
    )
      add(element.getAttribute("href"));
  }
  for (const element of doc.querySelectorAll("video[poster]")) add(element.getAttribute("poster"));
  for (const element of doc.querySelectorAll("object[data]")) add(element.getAttribute("data"));
  for (const element of doc.querySelectorAll("svg image, svg use"))
    add(element.getAttribute("href") ?? element.getAttribute("xlink:href"));
  return resources;
}
