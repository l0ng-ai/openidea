import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { call, commands, IpcError, isTauri } from "@/platform/ipc";
import { invokeLocal } from "@/platform/tauriCore";
import { ipcPath } from "@/platform/paths";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { registerFileDropHandler } from "@/workbench/fileDrop";

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)$/i;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdx|ronn|workbook)$/i.test(path);
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + parts.join("/");
}

export function imageTarget(markdown: string, folder: string, name: string): string {
  const path = ipcPath(markdown);
  const relative = folder.trim().replace(/\\/g, "/") || "assets";
  if (relative.startsWith("/") || /^[a-z]:/i.test(relative)) throw new Error(tx("Image folder must be relative."));
  return normalize(`${path.slice(0, path.lastIndexOf("/"))}/${relative}/${name}`);
}

export function relativeImagePath(markdown: string, target: string): string {
  const from = normalize(ipcPath(markdown)).split("/").slice(0, -1);
  const to = normalize(ipcPath(target)).split("/");
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to]
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export function imageName(source: string, mime: string, pattern: string, now = new Date()): string {
  if (source) return source.replace(/^.*[\\/]/, "");
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const stem = (pattern.trim() || "image-{timestamp}")
    .replaceAll("{timestamp}", timestamp)
    // Filenames cannot contain control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
  const ext =
    ({ "image/jpeg": "jpg", "image/svg+xml": "svg", "image/x-icon": "ico" } as Record<string, string>)[mime] ||
    mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ||
    "png";
  return `${stem}.${ext}`;
}

export async function saveImage(
  markdown: string,
  folder: string,
  name: string,
  data: number[],
  create = (path: string, bytes: number[]) => call(commands.fsCreateFileBytes(path, bytes)),
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; ; n++) {
    const target = imageTarget(markdown, folder, `${stem}${n ? `-${n}` : ""}${ext}`);
    try {
      await create(target, data);
      return `![](${relativeImagePath(markdown, target)})`;
    } catch (error) {
      if (!(error instanceof IpcError) || error.kind !== "alreadyExists") throw error;
    }
  }
}

function imageBytes(blob: Blob | string): Promise<number[]> {
  if ((typeof blob === "string" ? blob.length * 0.75 : blob.size) > MAX_IMAGE_BYTES)
    return Promise.reject(new Error(tx("Image exceeds 16 MB.")));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./imageBytes.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ data: number[]; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(blob);
  });
}

interface ImageOptions {
  path: string;
  folder: string;
  pattern: string;
}

export function markdownImages(options: ImageOptions): Extension {
  if (!isMarkdown(options.path)) return [];
  return ViewPlugin.fromClass(
    class {
      alive = true;
      pending = new Set<{ from: number; to: number }>();
      unregister: () => void;
      constructor(readonly view: EditorView) {
        this.unregister = registerFileDropHandler((paths, x, y) => {
          const rect = view.dom.getBoundingClientRect();
          if (
            x < rect.left ||
            x > rect.right ||
            y < rect.top ||
            y > rect.bottom ||
            !paths.every((p) => IMAGE_FILE.test(p)) ||
            view.state.readOnly
          )
            return false;
          this.insert(
            paths.map((path) => async () => {
              // OS paths belong to this client even in a remote project.
              const url = await invokeLocal<string>("fs_read_image", { path });
              return { blob: url, name: path.replace(/^.*[\\/]/, "") };
            }),
            view.posAtCoords({ x, y }) ?? view.state.selection.main.head,
          );
          return true;
        });
      }
      update(update: ViewUpdate) {
        for (const range of this.pending) {
          range.from = update.changes.mapPos(range.from, 1);
          range.to = update.changes.mapPos(range.to, 1);
        }
      }
      destroy() {
        this.alive = false;
        this.unregister();
      }
      insert(sources: Array<() => Promise<{ blob: Blob | string; name: string }>>, position?: number) {
        const selection = this.view.state.selection.main;
        const range = { from: position ?? selection.from, to: position ?? selection.to };
        this.pending.add(range);
        void (async () => {
          const links: string[] = [];
          try {
            for (const source of sources) {
              const { blob, name } = await source();
              if (!this.alive) return;
              const bytes = await imageBytes(blob);
              if (!this.alive) return;
              links.push(
                await saveImage(
                  options.path,
                  options.folder,
                  imageName(name, typeof blob === "string" ? "image/png" : blob.type, options.pattern),
                  bytes,
                ),
              );
            }
            if (this.alive && !this.view.state.readOnly) {
              const text = links.join("\n");
              this.view.dispatch({
                changes: { from: range.from, to: range.to, insert: text },
                selection: EditorSelection.cursor(range.from + text.length),
                annotations: isolateHistory.of("full"),
                userEvent: "input.paste.image",
                filter: false,
                scrollIntoView: true,
              });
            }
          } catch (error) {
            notifications().notify({ level: "error", title: tx("Cannot insert image"), body: String(error) });
          } finally {
            this.pending.delete(range);
          }
        })();
      }
      files(event: ClipboardEvent | DragEvent): boolean {
        if (this.view.state.facet(EditorState.readOnly)) return false;
        const transfer = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
        const files = Array.from(transfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (!files.length) return false;
        event.preventDefault();
        // WebKit names raw clipboard images "image.png", which can also be a real filename.
        const copiedPaths =
          event.type === "paste" && files.some((file) => file.name === "image.png") && isTauri()
            ? call(commands.clipboardFileList()).catch(() => [])
            : Promise.resolve([] as string[]);
        this.insert(
          files.map((file) => async () => ({
            blob: file,
            name:
              file.name === "image.png" &&
              event.type === "paste" &&
              !(await copiedPaths).some((path) => path.replace(/^.*[\\/]/, "") === file.name)
                ? ""
                : file.name,
          })),
          event.type === "drop"
            ? (this.view.posAtCoords({ x: (event as DragEvent).clientX, y: (event as DragEvent).clientY }) ?? undefined)
            : undefined,
        );
        return true;
      }
    },
    {
      eventHandlers: {
        paste(event) {
          return this.files(event);
        },
        drop(event) {
          return this.files(event);
        },
      },
    },
  );
}
