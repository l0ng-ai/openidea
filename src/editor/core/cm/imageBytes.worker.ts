// Keep binary conversion off the editor thread, including for large clipboard images.
self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    self.postMessage({ data: Array.from(new Uint8Array(await event.data.arrayBuffer())) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
