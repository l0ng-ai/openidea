import { isolateHistory } from "@codemirror/commands";
import { activeEditor, useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { imageName, imageStem, MAX_IMAGE_BYTES, relativeImagePath } from "@/editor/core/cm/markdownImages";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, IpcError } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { confirm } from "@/workbench/messages";
import { notifications } from "@/workbench/contributions";
import { isMarkdownPath } from "../fileKinds";

export const EXTRACT_IMAGES = "markdown.extractEmbeddedImages";
export const EXTRACT_IMAGES_TITLE = "Extract Embedded Images…";

const running = new Set<number>();
const IMAGE_SIGNATURES = new Map<string, (bytes: string) => boolean>([
  ["image/jpeg", (bytes) => bytes.startsWith("\xff\xd8\xff")],
  ["image/png", (bytes) => bytes.startsWith("\x89PNG\r\n\x1a\n")],
  ["image/gif", (bytes) => bytes.startsWith("GIF87a") || bytes.startsWith("GIF89a")],
  ["image/webp", (bytes) => bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP"],
]);
const LITERAL_HTML = /^(?:code|pre|script|style|textarea|title|xmp|iframe|noembed|noframes)$/i;
const EXTRACTION_COMMANDS = ["fs_entry_kind", "fs_create_dir", "fs_create_file_bytes"];

interface ImageDestination {
  from: number;
  to: number;
  mime: string;
  base64: string;
}

export function canExtractImages(editor: TextEditorHandle | null = activeEditor()): editor is TextEditorHandle {
  if (!editor?.tabId || editor.ctx.virtual || editor.ctx.readOnly || editor.view.state.readOnly || !isTauri())
    return false;
  const { path, doc } = editor.ctx;
  const { session, lost } = useRemote.getState();
  return (
    (path.startsWith("/") || /^[a-z]:\//i.test(path)) &&
    isMarkdownPath(path, "source") &&
    !running.has(doc) &&
    (!session || (!lost && EXTRACTION_COMMANDS.every((command) => session.commands.includes(command))))
  );
}

export async function extractImages() {
  const editor = activeEditor();
  if (!canExtractImages(editor)) return;

  const { view } = editor;
  const { path, doc } = editor.ctx;
  const snapshot = view.state.doc;
  const session = useRemote.getState().session;
  const checkDocument = () => {
    const remote = useRemote.getState();
    if (
      !useEditorRegistry.getState().editors.has(editor) ||
      editor.ctx.path !== path ||
      editor.ctx.doc !== doc ||
      editor.ctx.readOnly ||
      view.state.readOnly ||
      view.state.doc !== snapshot ||
      remote.session !== session ||
      remote.lost
    )
      throw new Error(tx("The document changed or is no longer editable."));
  };
  running.add(doc);
  let written = 0;
  let folder: { path: string; name: string } | undefined;
  try {
    const { images, invalid } = await embeddedImages(snapshot.toString());
    if (!images.length) {
      notifications().notify({
        level: "info",
        title: invalid ? tx("No valid embedded images found") : tx("No embedded images found"),
      });
      return;
    }
    checkDocument();
    folder = await availableImageFolder(path);
    checkDocument();
    const message = tx`Extract ${images.length} embedded images to ${folder.name}/ and replace their links in this document?`;
    if (
      !(await confirm({
        title: EXTRACT_IMAGES_TITLE,
        message: invalid
          ? message + " " + tx`${invalid} invalid, unsupported, or oversized images will be left unchanged.`
          : message,
        ok: "Extract",
      }))
    )
      return;

    checkDocument();
    await call(commands.fsCreateDir(folder.path));
    const changes = [];
    const width = Math.max(3, String(images.length).length);
    for (const image of images) {
      checkDocument();
      const number = String(written + 1).padStart(width, "0");
      const target = folder.path + "/" + imageName("", image.mime, `image-${number}`);
      // oxlint-disable-next-line no-await-in-loop -- verify the source before starting each exclusive write
      await call(commands.fsCreateFileBytes(target, image.base64));
      written++;
      changes.push({ from: image.from, to: image.to, insert: relativeImagePath(path, target) });
    }
    checkDocument();
    const replacements = view.state.changes(changes);
    const transaction = view.state.update({ changes: replacements, annotations: isolateHistory.of("full") });
    if (!transaction.newDoc.eq(replacements.apply(snapshot)))
      throw new Error(tx("The document no longer accepts changes."));
    view.dispatch(transaction);
    notifications().notify({
      level: "info",
      title: tx`Extracted ${written} embedded images`,
      body: tx`Saved to ${folder.name}/.`,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    notifications().notify({
      level: "error",
      title: tx("Could not extract embedded images"),
      body: folder
        ? tx`${reason} No image links were changed. ${written} image files were written to ${folder.name}/ before the operation stopped.`
        : reason,
    });
  } finally {
    running.delete(doc);
  }
}

async function availableImageFolder(path: string): Promise<{ path: string; name: string }> {
  const slash = path.lastIndexOf("/") + 1;
  const stem = imageStem(path.slice(slash).replace(/\.[^.]*$/, "")) || "document";
  for (let i = 1; ; i++) {
    const name = `${stem}-images${i === 1 ? "" : `-${i}`}`;
    const target = path.slice(0, slash) + name;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each candidate fixes the exact destination shown for confirmation
      await call(commands.fsEntryKind(target));
    } catch (error) {
      if (error instanceof IpcError && error.kind === "notFound") return { path: target, name };
      throw error;
    }
  }
}

export async function embeddedImages(text: string): Promise<{ images: ImageDestination[]; invalid: number }> {
  const [{ commonmarkLanguage }, { htmlLanguage }] = await Promise.all([
    import("@codemirror/lang-markdown"),
    import("@codemirror/lang-html"),
  ]);
  const images: ImageDestination[] = [];
  let invalid = 0;
  const add = (from: number, to: number) => {
    const [header, type] = /^data:(image\/[a-z0-9][a-z0-9.+-]*);base64,/i.exec(text.slice(from, to)) ?? [];
    if (!header || !type) return;
    const mime = type.toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
    const matchesImage = IMAGE_SIGNATURES.get(mime);
    if (!matchesImage) {
      invalid++;
      return;
    }
    const base64 = text.slice(from + header.length, to).replace(/[\t\n\f\r ]/g, "");
    try {
      const decoded = base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ? "" : atob(base64);
      if (decoded.length > MAX_IMAGE_BYTES || !matchesImage(decoded)) throw new Error();
      images.push({ from, to, mime, base64: btoa(decoded) });
    } catch {
      invalid++;
    }
  };

  let literalEnd = 0;
  commonmarkLanguage.parser.parse(text).iterate({
    enter(node) {
      if (node.name === "HTMLTag" && node.from >= literalEnd) {
        const [, name] = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(text.slice(node.from, node.to)) ?? [];
        if (name && LITERAL_HTML.test(name)) {
          const close = new RegExp(`</${name}\\s*>`, "gi");
          close.lastIndex = node.to;
          literalEnd = close.exec(text) ? close.lastIndex : text.length;
          return false;
        }
      }
      if (node.name === "Image" && node.from >= literalEnd) {
        const url = node.node.getChild("URL");
        if (url) {
          const wrapped = text[url.from] === "<";
          add(url.from + Number(wrapped), url.to - Number(wrapped));
        }
        return false;
      } else if (node.name === "HTMLTag" || node.name === "HTMLBlock") {
        const start = Math.max(node.from, literalEnd);
        const html = text.slice(start, node.to);
        if (!/data:image\//i.test(html)) return false;
        htmlLanguage.parser.parse(html).iterate({
          enter(tag) {
            if (tag.name === "Element") {
              const elementName = tag.node.firstChild?.getChild("TagName");
              if (elementName && LITERAL_HTML.test(html.slice(elementName.from, elementName.to))) return false;
            }
            if (tag.name !== "OpenTag" && tag.name !== "SelfClosingTag") return;
            const name = tag.node.getChild("TagName");
            if (!name || html.slice(name.from, name.to).toLowerCase() !== "img") return;
            for (const attr of tag.node.getChildren("Attribute")) {
              const attrName = attr.getChild("AttributeName");
              if (!attrName || html.slice(attrName.from, attrName.to).toLowerCase() !== "src") continue;
              const value = attr.getChild("AttributeValue");
              const quote = value && html[value.from];
              if (value && (quote === "'" || quote === '"') && html[value.to - 1] === quote)
                add(start + value.from + 1, start + value.to - 1);
              break;
            }
          },
        });
        return false;
      }
    },
  });
  return { images, invalid };
}
