/**
 * `@file` / `@folder/` / `@file:10-20` references drawn as chips (icon, name, lines), in the
 * composer and in sent messages: a click opens the file at its lines (a folder is selected in
 * the Project view), hovering shows the full path and the lines.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { computePosition, flip, offset, shift } from "@floating-ui/react-dom";
import { highlightInto, languageForPath } from "@/editor/lsp/markdown";
import { iconNode } from "@/editor/lsp/iconMarkup";
import { executeAction } from "@/platform/actions";
import { tx, useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { copyText, fileIconName, Icon } from "@/ui";
import { editorService } from "@/workbench/contributions";
import {
  fenceLabel,
  fencedBlocks,
  isQuoteLine,
  linesLabel,
  messageTokens,
  parseMention,
  resolveTyped,
  type Mention,
} from "./composerModel";
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

/** The chip as DOM, for the composer's editor; `onRemove` adds its × button. */
export function chipElement(path: string, mention: Mention, onRemove?: () => void): HTMLElement {
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
  if (onRemove) {
    chip.classList.add(styles.removable!);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = styles.chipRemove!;
    remove.setAttribute("aria-label", tx("Remove"));
    remove.append(iconNode("close", 10));
    remove.addEventListener("mousedown", (e) => e.preventDefault());
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemove();
    });
    chip.append(remove);
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
 * Message text with its references as chips, `/commands` tagged, `>` quotes and ``` blocks as cards.
 * `cwd` is the directory references resolve in.
 */
export function ReferencedText({ text, cwd }: { text: string; cwd: string }) {
  const [root, setRoot] = useState<HTMLSpanElement | null>(null);
  useReferenceHover(root);
  const all = text.split("\n");
  const blocks: ({ kind: "quote" | "text"; text: string } | { kind: "code"; info: string; text: string })[] = [];
  const push = (kind: "quote" | "text", body: string) => {
    const last = blocks.at(-1);
    if (last && last.kind === kind) last.text += `\n${body}`;
    else blocks.push({ kind, text: body });
  };
  let i = 0;
  for (const fence of [...fencedBlocks(all), null]) {
    const end = fence ? fence.open : all.length;
    for (; i < end; i++) {
      const line = all[i]!;
      const quote = isQuoteLine(line);
      push(quote ? "quote" : "text", quote ? line.replace(/^> ?/, "") : line);
    }
    if (!fence) break;
    blocks.push({ kind: "code", info: fence.info, text: all.slice(fence.open + 1, fence.close).join("\n") });
    i = fence.close + 1;
  }
  return (
    <span ref={setRoot} className={styles.text}>
      {blocks.map((block, n) => {
        if (block.kind === "code") return <CodeCard key={n} info={block.info} body={block.text} />;
        if (block.kind === "quote")
          return (
            <div key={n} className={styles.quote}>
              {block.text}
            </div>
          );
        // A block ends its own line: the paragraph after it starts without an empty one.
        const body = n > 0 ? block.text.replace(/^\n/, "") : block.text;
        return <Fragment key={n}>{inline(body, cwd)}</Fragment>;
      })}
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

const KIND_TITLES = { terminal: "Terminal", problems: "Problems", trace: "Stack Trace", text: "Pasted Text" } as const;
const KIND_ICONS = { terminal: "terminal", problems: "problems", trace: "exception", text: "text" } as const;

/** A ``` block's header: icon and title ("Terminal · zsh", "TypeScript"). */
function cardTitle(info: string): { icon: string; title: string } {
  const { kind, label, language } = fenceLabel(info);
  if (kind !== "code") {
    const title = tx(KIND_TITLES[kind]);
    return { icon: KIND_ICONS[kind], title: label ? `${title} · ${label}` : title };
  }
  const name = language && label === language ? languageForPath(`x.${language}`) : null;
  return { icon: language ? fileIconName(`x.${language}`) : "file", title: name ?? (label || tx("Code")) };
}

const lineCount = (count: number, t: typeof tx) => (count === 1 ? t("1 line") : t`${count} lines`);

const COMPOSER_PREVIEW_LINES = 5;

/**
 * A ``` block in the composer, folded to a card: its title, line count and first lines.
 * `onOpen` edits it as text; `onRemove` deletes it.
 */
export function codeCardElement(info: string, body: string, onOpen: () => void, onRemove: () => void): HTMLElement {
  const { icon, title } = cardTitle(info);
  const lines = body.split("\n");
  const card = document.createElement("div");
  card.className = styles.codeCard!;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", title);
  const head = document.createElement("div");
  head.className = styles.codeHead!;
  head.append(iconNode(icon, 14));
  const name = document.createElement("span");
  name.className = styles.codeTitle!;
  name.textContent = title;
  const meta = document.createElement("span");
  meta.className = styles.codeMeta!;
  meta.textContent = lineCount(lines.length, tx);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = styles.codeRemove!;
  remove.setAttribute("aria-label", tx("Remove"));
  remove.append(iconNode("close", 10));
  remove.addEventListener("mousedown", (e) => e.preventDefault());
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  head.append(name, meta, remove);
  const pre = document.createElement("pre");
  pre.className = clsx(styles.codeBody, lines.length > COMPOSER_PREVIEW_LINES && styles.codeFaded);
  const shown = lines.slice(0, COMPOSER_PREVIEW_LINES).join("\n");
  pre.textContent = shown;
  const { language, kind } = fenceLabel(info);
  if (kind === "code") void highlightInto(pre, shown, language);
  card.append(head, pre);
  card.title = tx("Click to edit");
  card.addEventListener("mousedown", (e) => e.preventDefault());
  card.addEventListener("click", onOpen);
  return card;
}

const MESSAGE_PREVIEW_LINES = 12;

/** A ``` block in a sent message: a card with its title, the code highlighted, long ones folded. */
function CodeCard({ info, body }: { info: string; body: string }) {
  const t = useTx();
  const { icon, title } = cardTitle(info);
  const lines = body.split("\n");
  const [open, setOpen] = useState(lines.length <= MESSAGE_PREVIEW_LINES);
  const code = useRef<HTMLPreElement>(null);
  const shown = open ? body : lines.slice(0, MESSAGE_PREVIEW_LINES).join("\n");
  useEffect(() => {
    const el = code.current;
    if (!el) return;
    el.textContent = shown;
    const { language, kind } = fenceLabel(info);
    if (kind === "code") void highlightInto(el, shown, language);
  }, [shown, info]);
  const more = lines.length - MESSAGE_PREVIEW_LINES;
  return (
    <div className={styles.codeCard} role="group" aria-label={title}>
      <div className={styles.codeHead}>
        <Icon name={icon} size={14} />
        <span className={styles.codeTitle}>{title}</span>
        <span className={styles.codeMeta}>{lineCount(lines.length, t)}</span>
        <button type="button" className={styles.codeCopy} aria-label={t("Copy")} onClick={() => void copyText(body)}>
          <Icon name="copy" size={12} />
        </button>
      </div>
      <pre ref={code} className={clsx(styles.codeBody, !open && styles.codeFaded)} />
      {more > 0 && (
        <button type="button" className={styles.codeMore} onClick={() => setOpen(!open)}>
          {open ? t("Show less") : t`Show ${more} more lines`}
        </button>
      )}
    </div>
  );
}
