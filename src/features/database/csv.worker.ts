import { parseCsv } from "./csv";

self.onmessage = (event: MessageEvent<{ text: string; path: string; header?: boolean }>) => {
  const { text, path, header } = event.data;
  self.postMessage(parseCsv(text, path, header));
};
