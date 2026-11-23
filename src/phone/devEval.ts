/** Dev only: answers `scripts/phone-eval.ts`. */
export function installPhoneEval() {
  const hot = import.meta.hot;
  if (!hot) return;
  hot.on("phone:eval", async ({ id, code }: { id: number; code: string }) => {
    let result: unknown;
    try {
      // eslint-disable-next-line no-new-func
      result = await new Function(`return (async () => (${code}))()`)();
    } catch (e) {
      result = { error: String(e) };
    }
    let text: string;
    try {
      text = JSON.stringify(result ?? null);
    } catch {
      text = JSON.stringify(String(result));
    }
    hot.send("phone:eval-result", { id, result: text });
  });
}
