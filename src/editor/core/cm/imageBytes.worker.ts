import { toBase64 } from "@/platform/base64";

// Keep binary conversion off the editor thread, including for large clipboard images.
self.onmessage = async (event: MessageEvent<Blob | string>) => {
  try {
    const source = event.data;
    const bytes =
      typeof source === "string"
        ? Uint8Array.from(atob(source.slice(source.indexOf(",") + 1)), (byte) => byte.charCodeAt(0))
        : new Uint8Array(await source.arrayBuffer());
    self.postMessage({ data: toBase64(bytes) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
