import type { AgentImage } from "@/bindings";
import type { Action } from "@/platform/actions";
import { writeClipboardPng } from "@/platform/clipboard";
import { notifications } from "@/workbench/contributions";

export const imageSrc = (image: AgentImage) => `data:${image.mimeType};base64,${image.data}`;

/** The clipboard accepts PNG; keep PNG bytes intact and render other formats at full resolution. */
export async function imagePng(image: AgentImage): Promise<Blob> {
  if (image.data.startsWith("iVBORw0KGgo")) {
    return new Blob([Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))], { type: "image/png" });
  }
  const loaded = new Image();
  const ready = new Promise<void>((resolve, reject) => {
    loaded.onload = () => resolve();
    loaded.onerror = () => reject(new Error("Cannot decode image"));
  });
  loaded.src = imageSrc(image);
  await ready;
  const canvas = document.createElement("canvas");
  canvas.width = loaded.naturalWidth;
  canvas.height = loaded.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot convert image to PNG");
  context.drawImage(loaded, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Cannot convert image to PNG"));
    }, "image/png"),
  );
}

export interface CopyImage {
  image: AgentImage;
  onCopied?: () => void;
}

export const copyImageAction: Action = {
  id: "agents.copyImage",
  title: "Copy Image",
  category: "Agents",
  hidden: true,
  icon: "copy",
  run: async ({ arg }) => {
    const value = arg as CopyImage | undefined;
    if (!value?.image?.data || typeof value.image.mimeType !== "string") return;
    try {
      await writeClipboardPng(imagePng(value.image));
      value.onCopied?.();
    } catch (error) {
      notifications().notify({ level: "error", title: "Couldn't copy the image", body: String(error) });
    }
  },
};
