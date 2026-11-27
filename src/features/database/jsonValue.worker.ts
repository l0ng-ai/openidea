import { formatJson, jsonErrorOf } from "./jsonValue";

self.onmessage = (event: MessageEvent<{ text: string; format: boolean }>) => {
  const { text, format } = event.data;
  self.postMessage({ text: format ? formatJson(text) : text, error: jsonErrorOf(text) });
};
