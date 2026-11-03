/**
 * The frame may not download files (no `allow-downloads`): Excalidraw's
 * "Save to disk" and image export click a download link, which this turns
 * into the IDE's save dialog (`openidea.saveFile`).
 */
const click = HTMLAnchorElement.prototype.click;

export function routeDownloadsToTheIde(bridge: OpenideaBridge) {
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    const href = this.href;
    if (!this.hasAttribute("download") || !/^(blob|data):/.test(href)) return click.call(this);
    const name = this.download || "untitled";
    void fetch(href)
      .then((r) => r.blob())
      .then((data) => bridge.saveFile({ name, data, filters: filtersFor(name) }))
      .catch((e: unknown) => console.error("could not save", name, e));
  };
}

function filtersFor(name: string): OpenideaFileFilter[] | undefined {
  const ext = /\.([\w]+)$/.exec(name)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  const label: Record<string, string> = { png: "PNG image", svg: "SVG image", excalidraw: "Excalidraw drawing" };
  return [{ name: label[ext] ?? ext.toUpperCase(), extensions: [ext] }];
}
