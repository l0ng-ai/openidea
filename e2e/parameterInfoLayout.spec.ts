import type { Page } from "@playwright/test";
import type { SignatureHelp } from "../src/bindings";
import { expect, openFromTree, stubDesktop, test } from "./fixtures";

function signature(name: string, parameters: string[]) {
  let offset = name.length + 1;
  const ranges: [number, number][] = parameters.map((parameter) => {
    const range: [number, number] = [offset, offset + parameter.length];
    offset = range[1] + 2;
    return range;
  });
  return { label: `${name}(${parameters.join(", ")}): Invoice`, parameters: ranges, documentation: null };
}

async function openParameterInfo(page: Page, help: SignatureHelp) {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate((help) => {
    window.__ipc.handlers.lsp_signature_help = () => help;
  }, help);
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Meta+p");
  const popup = page.locator(".cm-lsp-signature");
  await expect(popup).toBeVisible();
  return { editor, popup };
}

test("parameter info wraps long parameters and follows the editor width", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 700 });
  const parameter = "roundingPolicyForThirdPartyPaymentsWithMultipleSettlementCurrencies: RoundingPolicy";
  const { editor, popup } = await openParameterInfo(page, {
    signatures: [signature("formatInvoice", ["order: Cart", parameter, "currency: string"])],
    activeSignature: 0,
    activeParameter: 1,
  });
  await page.setViewportSize({ width: 560, height: 650 });
  await expect
    .poll(async () => {
      const [pane, hint] = await Promise.all([editor.boundingBox(), popup.boundingBox()]);
      return !!pane && !!hint && hint.x >= pane.x - 1 && hint.x + hint.width <= pane.x + pane.width + 1;
    })
    .toBe(true);
  await expect.poll(() => popup.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(popup.locator("b")).toHaveText(parameter);
  const fontSize = await editor.locator(".cm-content").evaluate((el) => getComputedStyle(el).fontSize);
  await expect(popup).toHaveCSS("font-size", fontSize);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
});

test("parameter info keeps the active overload visible and scrolls to the others", async ({ workbench: page }) => {
  const signatures = Array.from({ length: 20 }, (_, i) =>
    signature("formatInvoice", [`order: Cart${i}`, "currency: string"]),
  );
  const { popup } = await openParameterInfo(page, { signatures, activeSignature: 16, activeParameter: 1 });
  await expect(popup.locator(".cm-lsp-signature-row")).toHaveCount(signatures.length);
  const active = popup.locator(".cm-lsp-signature-active b");
  await expect(active).toHaveText("currency: string");
  await expect
    .poll(async () => {
      const [frame, parameter] = await Promise.all([popup.boundingBox(), active.boundingBox()]);
      return (
        !!frame && !!parameter && parameter.y >= frame.y && parameter.y + parameter.height <= frame.y + frame.height
      );
    })
    .toBe(true);
  expect(await popup.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await popup.hover();
  await page.mouse.wheel(0, -1200);
  await expect.poll(() => popup.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(
    popup.getByText("formatInvoice(order: Cart0, currency: string): Invoice", { exact: true }),
  ).toBeInViewport();
});
