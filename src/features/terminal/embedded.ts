/**
 * Terminal widgets embedded in other views (the `embeddedTerminal` service):
 * an xterm.js instance with the terminal's font, theme and links, whose input
 * and size go to the owner instead of a terminal PTY (a Run console emulating
 * a terminal feeds its process).
 */
import { writeClipboardText } from "@/platform/clipboard";
import { noteCopySource } from "@/platform/clipboardSource";
import { installTerminalDrop } from "./drop";
import { installDomRowCache } from "./domRowCache";
import { installTerminalPaste, pasteIntoTerminal } from "./paste";
import { ownTerminalInput } from "./imeInput";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./xtermInput.css";
import type { EmbeddedTerminal, EmbeddedTerminalOptions } from "@/workbench/contributions";
import { isImeKey } from "@/platform/ime";
import { terminalKeyAction } from "./keys";
import { useProject } from "@/platform/project";
import { usePlatform } from "@/platform/platformInfo";
import { workflowSettings } from "@/platform/workflowSettings";
import { OutputGate } from "./outputGate";
import { fitScheduler, settledResize } from "./fit";
import { watchWindowsPty, windowsPtyOptions } from "./windowsPty";
import { findTerminalLinks } from "./links";
import { LINK_HANDLER, fontFor, openExternal, openFileLink } from "./session";
import { MIN_CONTRAST_RATIO, readLinkColor, readTerminalTheme, remeasureWhenFontsLoad } from "./theme";
import { installLinkHighlights, xtermLink, type LinkHighlightController } from "./linkHighlights";
import { installModifierPathLinks, type ModifierPathLinksController } from "./pathLinks";

const live = new Map<Terminal, { links: LinkHighlightController; paths: ModifierPathLinksController }>();

/** Follows a theme change (called with the terminal sessions' own update). */
export function applyThemeToEmbedded() {
  const theme = readTerminalTheme();
  for (const [t, { links, paths }] of live) {
    t.options.theme = theme;
    links.refresh();
    paths.refresh();
  }
}

export function createEmbeddedTerminal(host: HTMLElement, opts: EmbeddedTerminalOptions): EmbeddedTerminal {
  const settings = workflowSettings().terminal;
  const font = fontFor(settings);
  const term = new Terminal({
    ...windowsPtyOptions(),
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
    if (isImeKey(e)) return true;
    const action = terminalKeyAction(e, term.hasSelection());
    if (action.kind === "send" && e.key === "Enter") {
      if (e.type === "keydown") term.input(action.data);
    } else if (action.kind === "copy") {
      if (e.type === "keydown") {
        const text = term.getSelection();
        noteCopySource(text, { kind: "terminal", title: "Terminal" });
        void writeClipboardText(text).catch(() => undefined);
      }
    } else if (action.kind === "paste") {
      // Keep xterm from sending Ctrl+V as ^V; the native paste reaches its textarea.
      return false;
    } else {
      return true;
    }
    e.preventDefault();
    return false;
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const linkHighlights = installLinkHighlights(term, readLinkColor);
  const pathLinks = installModifierPathLinks(term, host, {
    cwd: () => opts.cwd ?? useProject.getState().project?.root ?? "",
    color: readLinkColor,
  });
  live.set(term, { links: linkHighlights, paths: pathLinks });
  let lastSize = { cols: term.cols, rows: term.rows };
  const processResize = settledResize((cols, rows) => {
    if (cols === lastSize.cols && rows === lastSize.rows) return;
    lastSize = { cols, rows };
    opts.onResize(cols, rows);
  });
  const disposables: IDisposable[] = [
    watchWindowsPty(term),
    term.onData((d) => opts.onData(d)),
    term.onBinary((d) => opts.onData(d)),
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        const found = line ? findTerminalLinks(line.translateToString(true)) : [];
        if (!line || !found.length) return callback(undefined);
        callback(
          found.map((l) =>
            xtermLink(term, line, y, l, (event) => {
              event.preventDefault();
              if (l.kind === "url") void openExternal(l.url);
              else void openFileLink(l, opts.cwd ?? useProject.getState().project?.root ?? "");
            }),
          ),
        );
      },
    }),
  ];
  const removePaste = installTerminalPaste(host, (text) => pasteIntoTerminal(term, text));
  const removeDrop = installTerminalDrop(host, (text) => pasteIntoTerminal(term, text));
  term.open(host);
  installDomRowCache(term);
  if (opts["aria-label"]) term.textarea?.setAttribute("aria-label", opts["aria-label"]);
  // The same WKWebView input-method fixes as the terminal sessions.
  if (term.textarea && usePlatform.getState().os === "macos") {
    disposables.push({ dispose: ownTerminalInput({ host, textarea: term.textarea, send: opts.onData }) });
  }

  const fitter = fitScheduler(() => {
    if (!host.isConnected || host.offsetWidth === 0 || host.offsetHeight === 0) return false;
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
    if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows);
    processResize.resized(dims.cols, dims.rows);
  });
  const scheduleFit = () => {
    processResize.cancel();
    fitter.schedule();
  };
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(host);
  scheduleFit();
  remeasureWhenFontsLoad(term, font, () => live.has(term), scheduleFit);
  // The owner learns the initial size even when it matches xterm's default.
  queueMicrotask(() => opts.onResize(term.cols, term.rows));

  // Max FPS paces Run console output too (#5897), and a hidden window paints slowly.
  const gate = new OutputGate({
    maxFps: () => workflowSettings().terminal.maxFps,
    hidden: () => typeof document !== "undefined" && document.hidden,
    write: (data) => term.write(data),
  });

  return {
    write: (data) => gate.push(data),
    clear: () => {
      gate.clear();
      term.reset();
    },
    focus: () => term.focus(),
    fit: () => fitter.flush(),
    dispose: () => {
      gate.clear();
      gate.dispose();
      fitter.cancel();
      processResize.cancel();
      observer.disconnect();
      removePaste();
      removeDrop();
      for (const d of disposables) d.dispose();
      const controllers = live.get(term);
      controllers?.links.dispose();
      controllers?.paths.dispose();
      live.delete(term);
      term.dispose();
    },
  };
}
