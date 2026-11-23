/**
 * `pnpm dev:phone` only: runs JavaScript in the phone app's webview for debugging the
 * simulator / emulator build. `curl -s localhost:1430/__phone_eval --data-binary 'expr'`
 * evaluates `expr` there (through Vite's HMR socket) and answers with its JSON result.
 */
import type { Plugin } from "vite";

export function phoneEval(): Plugin {
  let next = 1;
  const waiting = new Map<number, (result: string) => void>();
  return {
    name: "openidea-phone-eval",
    apply: "serve",
    configureServer(server) {
      server.ws.on("phone:eval-result", (data: { id: number; result: string }) => {
        waiting.get(data.id)?.(data.result);
        waiting.delete(data.id);
      });
      server.middlewares.use("/__phone_eval", (req, res) => {
        let code = "";
        req.on("data", (c: Buffer) => (code += c.toString()));
        req.on("end", () => {
          const id = next++;
          const timer = setTimeout(() => {
            waiting.delete(id);
            res.statusCode = 504;
            res.end("no answer from the phone");
          }, 10_000);
          waiting.set(id, (result) => {
            clearTimeout(timer);
            res.setHeader("content-type", "application/json");
            res.end(result);
          });
          server.ws.send("phone:eval", { id, code });
        });
      });
    },
  };
}
