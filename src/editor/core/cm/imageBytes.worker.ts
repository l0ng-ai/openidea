// Keep binary conversion off the editor thread, including for large clipboard images.
self.onmessage = async (event: MessageEvent<Blob | string>) => {
  try {
    const source = event.data;
    const data =
      typeof source === "string"
        ? Array.from(atob(source.slice(source.indexOf(",") + 1)), (byte) => byte.charCodeAt(0))
        : Array.from(new Uint8Array(await source.arrayBuffer()));
    self.postMessage({ data });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
