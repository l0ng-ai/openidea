/**
 * Terminal widgets embedded in other views (the `embeddedTerminal` service):
 * an xterm.js instance with the terminal's font, theme and links, whose input
 * and size go to the owner instead of a terminal PTY (a Run console emulating
 * a terminal feeds its process).
 */
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { EmbeddedTerminal, EmbeddedTerminalOptions } from "@/workbench/contributions";
import { isImeKey } from "@/platform/ime";
import { terminalKeyAction } from "./keys";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { fitScheduler, settledResize } from "./fit";
import { findTerminalLinks } from "./links";
import { LINK_HANDLER, fontFor, openExternal, openFileLink } from "./session";
import { MIN_CONTRAST_RATIO, readTerminalTheme, remeasureWhenFontsLoad } from "./theme";

const live = new Set<Terminal>();

/** Follows a theme change (called with the terminal sessions' own update). */
export function applyThemeToEmbedded() {
  const theme = readTerminalTheme();
  for (const t of live) t.options.theme = theme;
}

export function createEmbeddedTerminal(host: HTMLElement, opts: EmbeddedTerminalOptions): EmbeddedTerminal {
  const settings = workflowSettings().terminal;
  const font = fontFor(settings);
  const term = new Terminal({
    linkHandler: LINK_HANDLER,
    fontFamily: font.family,
    fontSize: font.size,
    lineHeight: font.lineHeight,
    letterSpacing: font.letterSpacing,
    fontWeight: font.weight,
    fontWeightBold: font.boldWeight,
    cursorBlink: settings.cursorBlink,
    cursorWidth: 2,
    cursorInactiveStyle: "outline",
    allowProposedApi: true,
    scrollback: 10_000,
    macOptionIsMeta: settings.optionAsMeta,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: MIN_CONTRAST_RATIO,
    smoothScrollDuration: 0,
    convertEol: false,
    theme: readTerminalTheme(),
  });
  term.attachCustomKeyEventHandler((e) => {
    if (isImeKey(e) || terminalKeyAction(e, term.hasSelection()).kind !== "copy") return true;
    if (e.type === "keydown") void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
    e.preventDefault();
    return false;
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  live.add(term);
  const processResize = settledResize((cols, rows) => opts.onResize(cols, rows));
  const disposables: IDisposable[] = [
    term.onData((d) => opts.onData(d)),
    term.onBinary((d) => opts.onData(d)),
    term.onResize(({ cols, rows }) => processResize.resized(cols, rows)),
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        const found = line ? findTerminalLinks(line.translateToString(true)) : [];
        if (!found.length) return callback(undefined);
        callback(
          found.map((l) => ({
            text: l.text,
            range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
            decorations: { underline: true, pointerCursor: true },
            activate: (event: MouseEvent) => {
              event.preventDefault();
              if (l.kind === "url") void openExternal(l.url);
              else void openFileLink(l, opts.cwd ?? useProject.getState().project?.root ?? "");
            },
          })),
        );
      },
    }),
  ];
  term.open(host);
  if (opts["aria-label"]) term.textarea?.setAttribute("aria-label", opts["aria-label"]);

  const fitter = fitScheduler(() => {
    if (!host.isConnected || host.offsetWidth === 0 || host.offsetHeight === 0) return;
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows);
  });
  const scheduleFit = () => fitter.schedule();
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(host);
  scheduleFit();
  remeasureWhenFontsLoad(term, font, () => live.has(term), scheduleFit);
  // The owner learns the initial size even when it matches xterm's default.
  queueMicrotask(() => opts.onResize(term.cols, term.rows));

  return {
    write: (data) => term.write(data),
    clear: () => term.reset(),
    focus: () => term.focus(),
    fit: () => fitter.flush(),
    dispose: () => {
      fitter.cancel();
      processResize.cancel();
      observer.disconnect();
      for (const d of disposables) d.dispose();
      live.delete(term);
      term.dispose();
    },
  };
}
