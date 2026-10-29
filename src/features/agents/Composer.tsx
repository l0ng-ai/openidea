/**
 * The message box of the New Task page and of sessions: `@` file references (project file
 * search), `/` agent commands, ↑ / ↓ history, pasted or dropped images, Shift+Tab to cycle
 * the agent's mode. Its draft lives in the store under `id`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { AgentCommand, AgentConfigOption, AgentImage } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { notifications, OWNS_FILE_DROP } from "@/workbench/contributions";
import { Icon, IconButton, Popup, fileIconName } from "@/ui";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  applyCompletion,
  atEdgeLine,
  completionAt,
  imageFromDataUrl,
  matchCommands,
  mentionOf,
  modeOption,
  nextValue,
  recall,
  type Completion,
  type FileRef,
} from "./composerModel";
import { composerDraft, updateComposer, useAgents } from "./store";
import { useCompletionAnchor } from "./useCompletionAnchor";
import styles from "./Composer.module.css";
import { isImeKey } from "@/platform/ime";

const MAX_PROMPT_HEIGHT = 280;
const MAX_ITEMS = 12;

type Item = { kind: "file"; path: string; rel: string } | { kind: "command"; command: AgentCommand };

export interface ComposerProps {
  /** Store key of the draft. */
  id: string;
  placeholder: string;
  /** Directory `@` references resolve in (the task's worktree, or the project root). */
  root: string;
  /** The project root the file index covers. */
  projectRoot: string;
  commands: readonly AgentCommand[];
  /** Sent messages, newest first. */
  history: readonly string[];
  /** Settings; Shift+Tab cycles the mode one. */
  config: readonly AgentConfigOption[];
  onConfig?: (option: string, value: string) => void;
  /** `now`: ⌘↵ (send even while the agent works, interrupting it). */
  onSubmit: (now: boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Left of the bottom row: agent / model / mode pickers. */
  toolbar?: ReactNode;
  /** Right of the bottom row: send / stop buttons. */
  actions?: ReactNode;
  className?: string;
}

export function Composer(props: ComposerProps) {
  const { id, root, projectRoot } = props;
  const tx = useTx();
  const draft = useAgents((s) => s.composers.get(id));
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [files, setFiles] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const recalled = useRef<{ index: number; stash: string }>({ index: -1, stash: "" });

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);

  const focus = useAgents((s) => (s.focus?.key === id ? s.focus.seq : 0));
  useEffect(() => {
    const el = ref.current;
    if (!focus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [focus]);

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_PROMPT_HEIGHT)}px`;
  }, [text]);

  // `@` completion: project file search, mapped into the task's directory.
  useEffect(() => {
    if (completion?.kind !== "file") return;
    let alive = true;
    const timer = setTimeout(() => {
      call(commands.findFiles(completion.query, MAX_ITEMS))
        .then((found) => {
          if (!alive) return;
          setFiles(
            found.map((f) => ({
              kind: "file",
              rel: f.relPath,
              path: root === projectRoot ? f.path : `${root}/${f.relPath}`,
            })),
          );
        })
        .catch(() => alive && setFiles([]));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [completion?.kind, completion?.query, root, projectRoot]);

  const items: Item[] = useMemo(() => {
    if (!completion) return [];
    if (completion.kind === "file") return files;
    return matchCommands(props.commands, completion.query)
      .slice(0, MAX_ITEMS)
      .map((command) => ({ kind: "command", command }));
  }, [completion, files, props.commands]);
  const open = !!completion && items.length > 0;
  const completionAnchor = useCompletionAnchor(ref, open ? completion.to : null, text);

  const setText = (value: string, caret?: number, restoreSelection = true) => {
    updateComposer(id, { text: value });
    const c = caret ?? value.length;
    setCompletion(completionAt(value, c));
    setActive(0);
    if (caret !== undefined && restoreSelection) {
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(caret, caret);
      });
    }
  };

  const accept = (item: Item | undefined) => {
    if (!item || !completion) return;
    if (item.kind === "file") {
      const mention = mentionOf(item.rel);
      const next = applyCompletion(text, completion, mention);
      const current = composerDraft(id);
      updateComposer(id, { files: [...current.files, { path: item.path, rel: item.rel } satisfies FileRef] });
      setText(next.text, next.caret);
    } else {
      const next = applyCompletion(text, completion, `/${item.command.name}`);
      setText(next.text, next.caret);
    }
    setCompletion(null);
  };

  const addImages = (list: AgentImage[]) => {
    if (list.length) updateComposer(id, { images: [...composerDraft(id).images, ...list] });
  };

  const readImageFiles = (picked: Iterable<File>) => {
    for (const file of picked) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        notifications().notify({ level: "warning", title: "Image too large", body: tx`${file.name} is over 5 MB.` });
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const image = typeof reader.result === "string" ? imageFromDataUrl(reader.result, file.name || "image") : null;
        if (image) addImages([image]);
      };
      reader.readAsDataURL(file);
    }
  };

  // Files dropped from the OS onto the box: images are attached, other files referenced.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type !== "drop" || !p.paths.length) return;
          const box = boxRef.current?.getBoundingClientRect();
          const ratio = window.devicePixelRatio || 1;
          const [x, y] = [p.position.x / ratio, p.position.y / ratio];
          if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return;
          const refs: FileRef[] = [];
          for (const path of p.paths) {
            if (IMAGE_EXTENSIONS.test(path)) {
              void call(commands.fsReadImage(path)).then((url) => {
                const image = imageFromDataUrl(url, basename(path));
                if (image) addImages([image]);
              });
            } else {
              refs.push({ path, rel: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path });
            }
          }
          if (refs.length) {
            const current = composerDraft(id);
            const mentions = refs.map((r) => mentionOf(r.rel)).join(" ");
            const glue = current.text && !/\s$/.test(current.text) ? " " : "";
            updateComposer(id, { text: `${current.text}${glue}${mentions} `, files: [...current.files, ...refs] });
          }
        })
        .then((u) => {
          if (disposed) u();
          else unlisten = u;
        }),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribe only when the target changes
  }, [id, root]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + d + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCompletion(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!props.disabled) props.onSubmit(e.metaKey || e.ctrlKey);
      recalled.current = { index: -1, stash: "" };
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      const mode = modeOption(props.config);
      const value = mode && nextValue(mode);
      if (mode && value && props.onConfig) {
        e.preventDefault();
        props.onConfig(mode.id, value);
      }
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.metaKey) {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const el = e.currentTarget;
      const r = recalled.current;
      // Only from an empty box or one showing a recalled message, with the caret on the edge line.
      const fresh = r.index === -1 ? text === "" : text === props.history[r.index];
      if (!fresh || !atEdgeLine(text, el.selectionStart, dir)) return;
      const next = recall(props.history, r.index, dir);
      if (next === null) return;
      e.preventDefault();
      if (r.index === -1) r.stash = text;
      r.index = next;
      const value = next === -1 ? r.stash : props.history[next]!;
      setText(value, value.length);
      setCompletion(null);
    }
  };

  return (
    <div
      ref={boxRef}
      className={clsx(styles.composer, props.className)}
      {...OWNS_FILE_DROP}
      onClick={() => ref.current?.focus()}
    >
      {open && completionAnchor && (
        <Popup
          open
          anchor={completionAnchor}
          placement="bottom-start"
          autoFocus={false}
          restoreFocus={false}
          closeOnOutsideClick={false}
          onClose={() => setCompletion(null)}
          className={styles.popup}
          role="listbox"
          aria-label={tx(completion.kind === "file" ? "Files" : "Commands")}
        >
          <div className={styles.items}>
            {items.map((item, i) => (
              <div
                key={item.kind === "file" ? item.path : item.command.name}
                role="option"
                aria-selected={i === active}
                className={clsx(styles.item, i === active && styles.active)}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
              >
                {item.kind === "file" ? (
                  <>
                    <Icon name={fileIconName(basename(item.rel))} size={16} />
                    <span className={styles.itemName}>{basename(item.rel)}</span>
                    <span className={styles.itemDetail}>{item.rel}</span>
                  </>
                ) : (
                  <>
                    <span className={styles.itemName}>/{item.command.name}</span>
                    {item.command.hint && <span className={styles.itemHint}>{item.command.hint}</span>}
                    <span className={styles.itemDetail}>{item.command.description}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </Popup>
      )}
      {images.length > 0 && (
        <div className={styles.images} onClick={(e) => e.stopPropagation()}>
          {images.map((img, i) => (
            <span key={i} className={styles.image} title={img.name ?? undefined}>
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name ?? tx("Image")} />
              <button
                type="button"
                className={styles.removeImage}
                aria-label={tx("Remove Image")}
                onClick={() => updateComposer(id, { images: images.filter((_, j) => j !== i) })}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className={styles.textarea}
        rows={2}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        value={text}
        aria-label={tx("Message")}
        placeholder={tx(props.placeholder)}
        onChange={(e) => setText(e.target.value, e.target.selectionStart, false)}
        onSelect={(e) => setCompletion(completionAt(e.currentTarget.value, e.currentTarget.selectionStart))}
        onBlur={() => setCompletion(null)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (pasted.length) {
            e.preventDefault();
            readImageFiles(pasted);
          }
        }}
      />
      <div className={styles.bar} onClick={(e) => e.stopPropagation()}>
        {props.toolbar}
        <span className={styles.spacer} />
        <IconButton
          icon="file"
          title="Reference a File (@)"
          size="small"
          onClick={() => {
            const glue = text && !/\s$/.test(text) ? " " : "";
            setText(`${text}${glue}@`, text.length + glue.length + 1);
          }}
        />
        <IconButton icon="file-image" title="Attach Image…" size="small" onClick={() => imageInput.current?.click()} />
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            readImageFiles(e.target.files ?? []);
            e.target.value = "";
          }}
        />
        {props.actions}
      </div>
    </div>
  );
}
