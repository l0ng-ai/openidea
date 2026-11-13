/**
 * `@file` / `@folder/` / `@file:10-20` references drawn as chips (icon, name, lines), in the
 * composer and in sent messages: a click opens the file at its lines (a folder is selected in
 * the Project view), hovering shows the full path and the lines.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { computePosition, flip, offset, shift } from "@floating-ui/react-dom";
import { highlightInto, languageForPath } from "@/editor/lsp/markdown";
import { iconNode } from "@/editor/lsp/iconMarkup";
import { executeAction } from "@/platform/actions";
import { tx, useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { fileIconName, Icon } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { isQuoteLine, linesLabel, messageTokens, parseMention, resolveTyped, type Mention } from "./composerModel";
import styles from "./ReferenceChip.module.css";

export { styles as chipStyles };

/** Whether a path names an existing file or folder, per path (the same files come up again and again). */
const existing = new Map<string, Promise<boolean>>();
export function fileExists(path: string): Promise<boolean> {
  let known = existing.get(path);
  if (!known) {
    known = call(commands.fsProbe(path)).then(
      () => true,
      () => false,
    );
    existing.set(path, known);
  }
  return known;
}

/** Opens a referenced file at its first line, or selects a folder in the Project view. */
export function openReference(path: string, mention: Mention) {
  if (mention.dir) {
    void executeAction("navigate.selectInProjectView", path.replace(/\/$/, ""));
    return;
  }
  const selection = mention.lines ? { line: mention.lines.from - 1, col: 0 } : undefined;
  void editorService().openFile(path, { selection, focus: true });
}

const nameOf = (m: Mention) => basename(m.rel.replace(/\/$/, "")) || m.rel;
const iconOf = (m: Mention) => (m.dir ? "folder" : fileIconName(nameOf(m), m.rel));

/** The chip as DOM, for the composer's editor. */
export function chipElement(path: string, mention: Mention): HTMLElement {
  const chip = document.createElement("span");
  chip.className = styles.chip!;
  chip.dataset.refPath = path;
  chip.dataset.refRel = mention.rel;
  if (mention.lines) chip.dataset.refLines = linesLabel(mention.lines);
  chip.setAttribute("aria-label", ariaLabel(mention));
  chip.append(iconNode(iconOf(mention), 14));
  const name = document.createElement("span");
  name.className = styles.name!;
  name.textContent = nameOf(mention);
  chip.append(name);
  if (mention.lines) {
    const lines = document.createElement("span");
    lines.className = styles.lines!;
    lines.textContent = linesLabel(mention.lines);
    chip.append(lines);
  }
  if (!mention.dir)
    void fileExists(path).then((exists) => {
      if (!exists) chip.classList.add(styles.missing!);
    });
  return chip;
}

function ariaLabel(m: Mention): string {
  const name = nameOf(m);
  if (m.dir) return tx`Folder reference ${name}`;
  if (!m.lines) return tx`File reference ${name}`;
  const lines = linesLabel(m.lines);
  return tx`File reference ${name}, lines ${lines}`;
}

/** A reference in a sent message. */
export function ReferenceChip({ path, mention }: { path: string; mention: Mention }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!mention.dir) void fileExists(path).then((exists) => alive && setMissing(!exists));
    return () => {
      alive = false;
    };
  }, [path, mention.dir]);
  return (
    <button
      type="button"
      className={clsx(styles.chip, missing && styles.missing)}
      data-ref-path={path}
      data-ref-rel={mention.rel}
      data-ref-lines={mention.lines ? linesLabel(mention.lines) : undefined}
      aria-label={ariaLabel(mention)}
      onClick={() => openReference(path, mention)}
    >
      <Icon name={iconOf(mention)} size={14} />
      <span className={styles.name}>{nameOf(mention)}</span>
      {mention.lines && <span className={styles.lines}>{linesLabel(mention.lines)}</span>}
    </button>
  );
}

/**
 * Message text with its references as chips, `/commands` tagged and `>` quotes as blocks.
 * `cwd` is the directory references resolve in.
 */
export function ReferencedText({ text, cwd }: { text: string; cwd: string }) {
  const [root, setRoot] = useState<HTMLSpanElement | null>(null);
  useReferenceHover(root);
  const blocks: { quote: boolean; text: string }[] = [];
  for (const line of text.split("\n")) {
    const quote = isQuoteLine(line);
    const last = blocks.at(-1);
    const body = quote ? line.replace(/^> ?/, "") : line;
    if (last && last.quote === quote) last.text += `\n${body}`;
    else blocks.push({ quote, text: body });
  }
  return (
    <span ref={setRoot} className={styles.text}>
      {blocks.map((block, i) =>
        block.quote ? (
          <div key={i} className={styles.quote}>
            {block.text}
          </div>
        ) : (
          // A quote ends its own line: the paragraph after it starts without an empty one.
          <Fragment key={i}>{inline(i > 0 ? block.text.replace(/^\n/, "") : block.text, cwd)}</Fragment>
        ),
      )}
    </span>
  );
}

function inline(text: string, cwd: string): ReactNode[] {
  return messageTokens(text).map((token, i) => {
    if (token.kind === "text") return <Fragment key={i}>{token.value}</Fragment>;
    if (token.kind === "command")
      return (
        <span key={i} className={styles.command}>
          {token.value}
        </span>
      );
    const mention = parseMention(token.value);
    if (!mention) return <Fragment key={i}>{token.value}</Fragment>;
    return <ReferenceChip key={i} path={resolveTyped(cwd, mention.rel)} mention={mention} />;
  });
}

const HOVER_DELAY = 400;
const PREVIEW_LINES = 12;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Hover cards for the chips below `root`: the full path, and the referenced lines (a file's
 * first lines without a range). Returns a disposer.
 */
export function referenceHover(root: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let card: HTMLElement | null = null;
  let current: HTMLElement | null = null;

  const hide = () => {
    clearTimeout(timer);
    card?.remove();
    card = null;
    current = null;
  };

  const place = (anchor: HTMLElement, el: HTMLElement) =>
    void computePosition(anchor, el, {
      strategy: "fixed",
      placement: "top-start",
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });

  const show = (chip: HTMLElement) => {
    const path = chip.dataset.refPath!;
    const rel = chip.dataset.refRel!;
    const mention = parseMention(
      `@${rel}${chip.dataset.refLines ? `:${chip.dataset.refLines.replace("–", "-")}` : ""}`,
    );
    if (!mention) return;
    const el = document.createElement("div");
    el.className = styles.card!;
    el.setAttribute("role", "tooltip");
    const head = document.createElement("div");
    head.className = styles.cardHead!;
    head.append(iconNode(iconOf(mention), 14));
    const name = document.createElement("span");
    name.className = styles.cardPath!;
    name.textContent = rel.replace(/\/$/, "");
    head.append(name);
    const meta = document.createElement("span");
    meta.className = styles.cardMeta!;
    const lines = mention.lines && linesLabel(mention.lines);
    meta.textContent = chip.classList.contains(styles.missing!)
      ? tx("File not found")
      : lines
        ? tx`Lines ${lines}`
        : mention.dir
          ? tx("Folder")
          : "";
    head.append(meta);
    el.append(head);
    document.body.append(el);
    card = el;
    place(chip, el);
    if (mention.dir || chip.classList.contains(styles.missing!)) return;
    void preview(path, mention).then((code) => {
      if (card !== el || !code) return;
      el.append(code);
      place(chip, el);
    });
  };

  const over = (e: PointerEvent) => {
    const chip = (e.target as Element | null)?.closest?.<HTMLElement>("[data-ref-path]") ?? null;
    if (chip === current) return;
    hide();
    if (!chip || !root.contains(chip)) return;
    current = chip;
    timer = setTimeout(() => show(chip), HOVER_DELAY);
  };

  root.addEventListener("pointerover", over);
  root.addEventListener("pointerleave", hide);
  root.addEventListener("pointerdown", hide, true);
  root.addEventListener("keydown", hide, true);
  root.addEventListener("scroll", hide, true);
  return () => {
    hide();
    root.removeEventListener("pointerover", over);
    root.removeEventListener("pointerleave", hide);
    root.removeEventListener("pointerdown", hide, true);
    root.removeEventListener("keydown", hide, true);
    root.removeEventListener("scroll", hide, true);
  };
}

async function preview(path: string, mention: Mention): Promise<HTMLElement | null> {
  try {
    const probe = await call(commands.fsProbe(path));
    if (probe.binary || probe.size > MAX_PREVIEW_BYTES) return null;
    const all = (await call(commands.fsReadText(path))).split("\n");
    const first = mention.lines ? Math.min(mention.lines.from, all.length) : 1;
    const last = Math.min(mention.lines ? mention.lines.to : PREVIEW_LINES, first + PREVIEW_LINES - 1, all.length);
    const lines = all.slice(first - 1, last).map((l) => l.replace(/\r$/, "").replace(/\t/g, "    "));
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    if (!lines.length) return null;
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
    const text = lines.map((l) => l.slice(indent)).join("\n");
    const code = document.createElement("pre");
    code.className = styles.cardCode!;
    const gutter = document.createElement("span");
    gutter.className = styles.cardLine!;
    gutter.textContent = lines.map((_, i) => first + i).join("\n");
    const body = document.createElement("code");
    body.textContent = text;
    code.append(gutter, body);
    await highlightInto(body, text, languageForPath(path));
    return code;
  } catch {
    return null;
  }
}

function useReferenceHover(root: HTMLElement | null) {
  const t = useTx();
  useEffect(() => (root ? referenceHover(root) : undefined), [root, t]);
}
