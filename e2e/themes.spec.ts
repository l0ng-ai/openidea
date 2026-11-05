import { expect, openFromTree, test } from "./fixtures";
import type { Page } from "@playwright/test";

test.setTimeout(60_000);

const palettes = [
  {
    id: "solarized-light",
    label: "Solarized Light",
    kind: "light",
    bg: "rgb(253, 246, 227)",
    fg: "rgb(101, 123, 131)",
    frame: [238, 232, 213, 255],
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    kind: "dark",
    bg: "rgb(0, 43, 54)",
    fg: "rgb(131, 148, 150)",
    frame: [7, 54, 66, 255],
  },
  {
    id: "one-light",
    label: "One Light",
    kind: "light",
    bg: "rgb(250, 250, 250)",
    fg: "rgb(56, 58, 66)",
    frame: [234, 234, 235, 255],
  },
  {
    id: "one-dark",
    label: "One Dark",
    kind: "dark",
    bg: "rgb(40, 44, 52)",
    fg: "rgb(171, 178, 191)",
    frame: [33, 37, 43, 255],
  },
];

async function choose(page: Page, control: string, label: string) {
  await page.getByRole("button", { name: control, exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
async function settings(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .locator('[role="treeitem"][aria-level="2"]')
    .filter({ hasText: /^Appearance$/ })
    .click();
  return dialog;
}

for (const palette of palettes) {
  test(`${palette.label}: settings, editor, terminal, popup and reload`, async ({ workbench: page }, info) => {
    const editor = await openFromTree(page, "build.gradle.kts");
    await page.keyboard.press("Alt+F12");
    await expect(page.locator(".xterm")).toBeVisible();
    // Use only synthetic ANSI output; no shell, network or native PTY is involved.
    await page.evaluate(async () => {
      const path = "/src/features/terminal/store.ts";
      const { activeSession } = await import(/* @vite-ignore */ path);
      const session = activeSession();
      session.term.clear();
      session.term.writeln("Synthetic theme regression — no PTY");
      session.term.writeln("\x1b[31merror\x1b[0m  \x1b[33mwarning\x1b[0m  \x1b[32msuccess\x1b[0m  \x1b[34minfo\x1b[0m");
    });
    const dialog = await settings(page);
    await choose(page, "Theme", palette.label);
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", palette.id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", palette.kind);
    expect(
      await page.evaluate(async () => {
        const path = "/src/workbench/theme.ts";
        const { windowBackgroundColor, windowBackgroundHex } = await import(/* @vite-ignore */ path);
        return { rgba: windowBackgroundColor(), hex: windowBackgroundHex() };
      }),
    ).toEqual({
      rgba: palette.frame,
      hex:
        "#" +
        palette.frame
          .slice(0, 3)
          .map((n) => n.toString(16).padStart(2, "0"))
          .join(""),
    });
    await page.screenshot({ path: info.outputPath(`${palette.id}-settings.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCSS("background-color", palette.bg);
    await expect(editor).toHaveCSS("color", palette.fg);
    await expect(editor.locator(".cm-gutters")).toHaveCSS("background-color", palette.bg);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = "/src/features/terminal/store.ts";
          const { activeSession } = await import(/* @vite-ignore */ path);
          return activeSession().term.options.theme.background;
        }),
      )
      .toBe(
        palette.id === "solarized-light"
          ? "#fdf6e3"
          : palette.id === "solarized-dark"
            ? "#002b36"
            : palette.id === "one-light"
              ? "#fafafa"
              : "#282c34",
      );
    await editor.locator(".cm-content").click();
    await page.keyboard.press("Meta+a");
    await expect(editor.locator(".cm-selectionBackground").first()).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Meta+f");
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("Order");
    await expect(editor.locator(".cm-openidea-findMatch").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${palette.id}-workbench.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await settings(page);
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Theme", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${palette.id}-popup.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", palette.id);
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("openidea.theme")!));
    expect(cached).toMatchObject({ theme: palette.kind, colorTheme: palette.id });
  });
}

test("same-kind switching, legacy themes, system mode and explicit editor schemes", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  const dialog = await settings(page);
  for (const label of [
    "Solarized Light",
    "One Light",
    "Solarized Dark",
    "One Dark",
    "Islands Light",
    "Islands Dark",
    "High Contrast",
  ]) {
    await choose(page, "Theme", label);
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    if (label === "High Contrast") await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
    else await expect(page.locator("html")).not.toHaveAttribute("data-contrast");
    const added = palettes.find((p) => p.label === label);
    if (added) await expect(page.locator("html")).toHaveAttribute("data-color-theme", added.id);
    else await expect(page.locator("html")).not.toHaveAttribute("data-color-theme");
    const bg =
      added?.bg ??
      (label === "Islands Light"
        ? "rgb(255, 255, 255)"
        : label === "Islands Dark"
          ? "rgb(25, 26, 28)"
          : "rgb(0, 0, 0)");
    await expect(page.locator(".cm-editor").first()).toHaveCSS("background-color", bg);
  }
  await choose(page, "Theme", "One Light");
  await choose(page, "Editor color scheme", "Solarized Dark");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".cm-editor").first()).toHaveCSS("background-color", "rgb(0, 43, 54)");
  await choose(page, "Editor color scheme", "Theme default");
  await dialog.getByLabel("Sync with OS", { exact: true }).check();
  await dialog.getByRole("button", { name: "Preferred themes", exact: true }).click();
  await choose(page, "Preferred light theme", "Solarized Light");
  await choose(page, "Preferred dark theme", "One Dark");
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "solarized-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "one-dark");
});

test("quick theme menu offers all four palettes and applies their kind", async ({ workbench: page }) => {
  for (const palette of palettes) {
    await page.getByRole("button", { name: "IDE and Project Settings", exact: true }).click();
    await page.getByText("Theme", { exact: true }).click();
    await page.getByText(palette.label, { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-color-theme", palette.id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", palette.kind);
  }
});

test("gear › Theme previews the theme under the pointer and keeps the one chosen", async ({ workbench: page }) => {
  const html = page.locator("html");
  const gear = page.getByRole("button", { name: "IDE and Project Settings", exact: true });
  const theme = (label: string) => page.getByRole("menuitemcheckbox", { name: label, exact: true });
  await gear.click();
  await page.getByRole("menuitem", { name: "Theme", exact: true }).hover();
  await theme("Solarized Dark").hover();
  await expect(html).toHaveAttribute("data-color-theme", "solarized-dark");
  // A plugin's theme previews too.
  await theme("Harbor Night").hover();
  await expect(html).toHaveAttribute("data-plugin-theme", /harbor-night$/);
  await expect(html).not.toHaveAttribute("data-color-theme");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(html).not.toHaveAttribute("data-plugin-theme");
  await expect(html).toHaveAttribute("data-theme", "light");

  await gear.click();
  await page.getByRole("menuitem", { name: "Theme", exact: true }).hover();
  await theme("One Dark").hover();
  await expect(html).toHaveAttribute("data-color-theme", "one-dark");
  await theme("One Dark").click();
  await expect(html).toHaveAttribute("data-color-theme", "one-dark");
  // Chosen, not previewed: the next start-up opens with it.
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("openidea.theme") ?? "{}").colorTheme))
    .toBe("one-dark");
});

test("Settings › Appearance › Theme previews the highlighted theme until Cancel", async ({ workbench: page }) => {
  const html = page.locator("html");
  const dialog = await settings(page);
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: "Solarized Dark", exact: true }).hover();
  await expect(html).toHaveAttribute("data-color-theme", "solarized-dark");
  await page.keyboard.press("Escape");
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).not.toHaveAttribute("data-color-theme");
  // Picked: it shows until Apply or Cancel.
  await choose(page, "Theme", "One Dark");
  await expect(html).toHaveAttribute("data-color-theme", "one-dark");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(html).not.toHaveAttribute("data-color-theme");
});
