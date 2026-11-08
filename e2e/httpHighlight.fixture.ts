import "../src/styles/tokens.css";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { registerLanguageMode } from "../src/editor/api";
import { openideaHighlightStyle } from "../src/editor/core/cm/highlight";
import { findLanguageDescription, loadSupport } from "../src/editor/core/cm/languages";
import { httpLanguageDescription } from "../src/features/http-client/language";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
document.body.style.backgroundColor = "var(--bg-editor)";
document.body.style.color = "var(--fg-editor)";
registerLanguageMode(httpLanguageDescription);
const file = params.has("rest") ? "requests.rest" : "requests.http";
const support = await loadSupport(findLanguageDescription("HTTP", file)!);
const http = document.createElement("div");
http.id = "http";
document.body.append(http);
new EditorView({
  parent: http,
  doc: `### gRPC request with a JSON body
GRPC localhost:9003/example.Greeter/SayHello
Content-Type: application/json

{
  "name": "World",
  "count": 12,
  "enabled": true,
  "empty": null,
  "items": [1, 2, 3]
}

### WebSocket message
WEBSOCKET ws://localhost:8080/events

{"message": "hello", "ready": false}

### Regular HTTP request
POST https://example.test/messages

{"message": "HTTP still works", "count": 1}`,
  extensions: [support!, syntaxHighlighting(openideaHighlightStyle)],
});

const json = document.createElement("div");
json.id = "json";
document.body.append(json);
new EditorView({
  parent: json,
  doc: '{"name": "World", "count": 12, "enabled": true, "ready": false, "empty": null, "items": [1]}',
  extensions: [
    await loadSupport(findLanguageDescription("JSON", "body.json")!),
    syntaxHighlighting(openideaHighlightStyle),
  ],
});
