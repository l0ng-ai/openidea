/**
 * The message box of the New Task page and of sessions: `@` file and folder references
 * (project index search), `/` agent commands, ↑ / ↓ history, pasted or dropped images, Shift+Tab to cycle
 * the agent's mode. Its draft lives in the store under `id`.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import type { AgentCommand, AgentConfigOption, AgentImage } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { nativeDropPoint } from "@/platform/nativeDrop";
import { invokeLocal } from "@/platform/tauriCore";
import { useTx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { notifications, OWNS_FILE_DROP } from "@/workbench/contributions";
import {
  FILES_DRAG,
  Icon,
  IconButton,
  InlineTag,
  List,
  Popup,
  firstSelectable,
  listNavigate,
  fileIconName,
  registerDropTarget,
} from "@/ui";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  applyCompletion,
  atEdgeLine,
  isPathQuery,
  mergeMatches,
  resolveTyped,
  completionAt,
  imageFromDataUrl,
  matchCommands,
  mentionOf,
  messageTokens,
  modeOption,
  nextValue,
  recall,
  toPrompt,
  type Completion,
  type FileRef,
} from "./composerModel";
import { composerDraft, updateComposer, useAgents } from "./store";
import { ImagePreview, imageSrc } from "./ImagePreview";
import { useCompletionAnchor } from "./useCompletionAnchor";
import styles from "./Composer.module.css";
import { isImeKey } from "@/platform/ime";

const MAX_PROMPT_HEIGHT = 280;
const MAX_ITEMS = 12;

type Item =
  | { kind: "file"; path: string; rel: string; dir?: boolean }
  | { kind: "command"; command: AgentCommand }
  | { kind: "section"; source: "command" | "skill" };

const isSection = (item: Item) => item.kind === "section";

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
  const tokens = useMemo(() => messageTokens(text), [text]);
  const [preview, setPreview] = useState<AgentImage | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [files, setFiles] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const composing = useRef(false);
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

  // A textarea that scrolls loses content width to its scrollbar: give the mirror the same
  // width and offset, or a long prompt wraps a line earlier and the painted text drifts.
  const syncMirror = useCallback(() => {
    const el = ref.current;
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    mirror.style.right = `${el.offsetWidth - el.clientWidth}px`;
    mirror.scrollTop = el.scrollTop;
  }, []);
  useLayoutEffect(syncMirror, [text, syncMirror]);

  // `@` completion: project file search, mapped into the task's directory.
  useEffect(() => {
    if (completion?.kind !== "file") return;
    let alive = true;
    const query = completion.query;
    const timer = setTimeout(() => {
      if (isPathQuery(query)) {
        // Outside the index: list the directory typed so far.
        const typed = /(^|\/)\.\.?$/.test(query) ? `${query}/` : query;
        const dirPart = typed.slice(0, typed.lastIndexOf("/") + 1);
        const last = typed.slice(dirPart.length);
        call(commands.pathCompletions(`${typed.startsWith("/") ? "" : root}/_`, typed))
          .then((found) => {
            if (!alive) return;
            setFiles(
              found
                .filter((f) => f.name.toLowerCase().startsWith(last.toLowerCase()))
                .slice(0, MAX_ITEMS)
                .map((f) => {
                  const rel = `${dirPart}${f.name}`;
                  return { kind: "file", rel, dir: f.dir, path: resolveTyped(root, rel) };
                }),
            );
          })
          .catch(() => alive && setFiles([]));
        return;
      }
      Promise.all([call(commands.findFiles(query, MAX_ITEMS)), call(commands.findDirs(query, MAX_ITEMS))])
        .then(async ([found, dirs]) => {
          if (!alive) return;
          // A bare `@`: the index has nothing to match on, so list the root instead of
          // showing no popup at all.
          if (!query && found.length + dirs.length === 0) {
            const top = await call(commands.pathCompletions(`${root}/_`, "")).catch(() => []);
            if (!alive) return;
            setFiles(
              top.slice(0, MAX_ITEMS).map((f) => ({
                kind: "file",
                rel: f.name,
                dir: f.dir,
                path: resolveTyped(root, f.name),
              })),
            );
            return;
          }
          setFiles(
            mergeMatches(found, dirs, MAX_ITEMS).map((f) => ({
              kind: "file",
              rel: f.rel,
              dir: f.dir,
              path: root === projectRoot ? f.path : `${root}/${f.rel}`,
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
    const out: Item[] = [];
    let source: "command" | "skill" | undefined;
    for (const command of matchCommands(props.commands, completion.query)) {
      const next = command.source ?? "command";
      if (source !== next) {
        source = next;
        out.push({ kind: "section", source });
      }
      out.push({ kind: "command", command });
    }
    return out;
  }, [completion, files, props.commands]);
  const activeIndex = items[active] && !isSection(items[active]!) ? active : firstSelectable(items, isSection);
  const open = !!completion && items.length > 0;
  const completionAnchor = useCompletionAnchor(ref, open ? completion.to : null, text);

  const setText = (value: string, caret?: number, restoreSelection = true) => {
    updateComposer(id, { text: value });
    const c = caret ?? value.length;
    setCompletion(composing.current ? null : completionAt(value, c));
    setActive(0);
    if (caret !== undefined && restoreSelection) {
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(caret, caret);
      });
    }
  };

  /** Enter or a click references the item; Tab on a folder keeps completing inside it. */
  const accept = (item: Item | undefined, descend = false) => {
    if (!item || item.kind === "section" || !completion) return;
    if (item.kind === "file") {
      const rel = item.dir ? `${item.rel}/` : item.rel;
      // A folder stays referenced while its `@folder/` is left as typed (`toPrompt`).
      const current = composerDraft(id);
      updateComposer(id, { files: [...current.files, { path: item.path, rel } satisfies FileRef] });
      if (item.dir && descend) {
        const insert = mentionOf(rel);
        setText(text.slice(0, completion.from) + insert + text.slice(completion.to), completion.from + insert.length);
        return;
      }
      const next = applyCompletion(text, completion, mentionOf(rel));
      setText(next.text, next.caret);
    } else {
      // Inserted in place: the order of the message is kept, and the text is tagged
      // where it stands (see the mirror below the textarea).
      const next = applyCompletion(text, completion, `/${item.command.name}`);
      setText(next.text, next.caret);
    }
    setCompletion(null);
  };

  const [fileOver, setFileOver] = useState(false);

  /** Adds paths as `@` references (a file or a folder), each once. */
  const addPaths = useCallback(
    (paths: readonly string[]) => {
      const current = composerDraft(id);
      const known = new Set(toPrompt(current).files);
      const files = current.files.filter((f) => known.has(f.path));
      const refs: FileRef[] = [];
      for (const raw of paths) {
        const source = resolveTyped("", raw.replace(/\\/g, "/"));
        const base = [root, projectRoot]
          .filter(Boolean)
          .map((path) => resolveTyped(path, "."))
          .find((path) => source === path || source.startsWith(`${path}/`));
        if (!base || !/^(\/|[A-Za-z]:[\\/])/.test(raw)) continue;
        const rel = source === base ? "." : source.slice(base.length + 1);
        const path = resolveTyped(root, rel);
        if (known.has(path)) continue;
        known.add(path);
        refs.push({ path, rel });
      }
      if (!refs.length) return;
      const mentions = refs.map((r) => mentionOf(r.rel)).join(" ");
      const glue = current.text && !/\s$/.test(current.text) ? " " : "";
      updateComposer(id, { text: `${current.text}${glue}${mentions} `, files: [...files, ...refs] });
    },
    [id, root, projectRoot],
  );

  const addImages = useCallback(
    (list: AgentImage[]) => {
      if (list.length) updateComposer(id, { images: [...composerDraft(id).images, ...list] });
    },
    [id],
  );

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
          const { x, y } = nativeDropPoint(p.position);
          if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return;
          const paths: string[] = [];
          for (const path of p.paths) {
            if (IMAGE_EXTENSIONS.test(path)) {
              void invokeLocal<string>("fs_read_image", { path }).then((url) => {
                const image = imageFromDataUrl(url, basename(path));
                if (image) addImages([image]);
              });
            } else {
              paths.push(path);
            }
          }
          addPaths(paths);
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
  }, [addPaths, addImages]);

  // Files and folders dragged from the Project view: the same `@` references.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    return registerDropTarget(el, {
      accepts: (type) => type === FILES_DRAG,
      over: () => setFileOver(true),
      leave: () => setFileOver(false),
      drop: (data) => {
        setFileOver(false);
        addPaths(data.payload.split("\n").filter(Boolean));
      },
    });
  }, [addPaths]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || isImeKey(e.nativeEvent)) return;
    const el = e.currentTarget;
    if (!e.altKey && !e.metaKey && !e.ctrlKey && el.selectionStart === el.selectionEnd) {
      const backward = e.key === "Backspace" || e.key === "ArrowLeft";
      const forward = e.key === "Delete" || e.key === "ArrowRight";
      if (backward || forward) {
        let offset = 0;
        for (const token of tokens) {
          const end = offset + token.value.length;
          const caret = el.selectionStart;
          if (token.kind !== "text" && (backward ? caret > offset && caret <= end : caret >= offset && caret < end)) {
            e.preventDefault();
            if (e.key === "Backspace" || e.key === "Delete") {
              setText(text.slice(0, offset) + text.slice(end), offset);
            } else {
              const next = backward ? offset : end;
              el.setSelectionRange(
                e.shiftKey ? Math.min(caret, next) : next,
                e.shiftKey ? Math.max(caret, next) : next,
              );
            }
            setCompletion(null);
            return;
          }
          offset = end;
        }
      }
    }
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = listNavigate(e.key, { items, active: activeIndex, isSection, wrap: true });
        if (next !== null) setActive(next);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[activeIndex], e.key === "Tab");
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
      className={clsx(styles.composer, fileOver && styles.fileOver, props.className)}
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
          role="presentation"
        >
          <List
            items={items}
            getKey={(item) =>
              item.kind === "section"
                ? `section:${item.source}`
                : item.kind === "file"
                  ? item.path
                  : `${item.command.source ?? "command"}:${item.command.name}`
            }
            isSection={isSection}
            renderSection={(item) => item.kind === "section" && tx(item.source === "skill" ? "Skills" : "Commands")}
            activeIndex={activeIndex}
            onActiveChange={setActive}
            onActivate={(item) => accept(item)}
            focusable={false}
            hoverSelects
            aria-label={tx(completion.kind === "file" ? "Files" : "Commands")}
            className={styles.items}
            renderItem={(item) =>
              item.kind === "section" ? null : item.kind === "file" ? (
                <>
                  <Icon name={item.dir ? "folder" : fileIconName(basename(item.rel), item.rel)} size={16} />
                  <span className={styles.itemName}>
                    {basename(item.rel)}
                    {item.dir && "/"}
                  </span>
                  <span className={styles.itemDetail}>{item.rel}</span>
                </>
              ) : (
                <>
                  <span className={styles.itemName}>/{item.command.name}</span>
                  {item.command.hint && <span className={styles.itemHint}>{item.command.hint}</span>}
                  <span className={styles.itemDetail}>{item.command.description}</span>
                </>
              )
            }
          />
        </Popup>
      )}
      {images.length > 0 && (
        <div className={styles.images} onClick={(e) => e.stopPropagation()}>
          {images.map((img, i) => (
            <span key={i} className={styles.image} title={img.name ?? undefined}>
              <button type="button" className={styles.previewImage} onClick={() => setPreview(img)}>
                <img src={imageSrc(img)} alt={img.name ?? tx("Image")} />
              </button>
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
          <ImagePreview image={preview} onClose={() => setPreview(null)} />
        </div>
      )}
      <div className={styles.field}>
        {/* The text is painted here with `@file` / `/skill` tags; the textarea above it
            keeps native editing, selection and the caret. */}
        <div ref={mirrorRef} className={styles.mirror} aria-hidden="true">
          {tokens.map((token, i) =>
            token.kind === "text" ? (
              <Fragment key={i}>{token.value}</Fragment>
            ) : (
              <InlineTag key={i} accent={token.kind === "command"}>
                {token.value}
              </InlineTag>
            ),
          )}
          {"\u200b"}
        </div>
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
          // The controlled text, not the event's value: closing the completion popup can emit a
          // stale select event with the old text.
          onSelect={(e) => setCompletion(composing.current ? null : completionAt(text, e.currentTarget.selectionStart))}
          onCompositionStart={() => {
            composing.current = true;
            setCompletion(null);
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onBlur={() => setCompletion(null)}
          onKeyDown={onKeyDown}
          onScroll={syncMirror}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (pasted.length) {
              e.preventDefault();
              readImageFiles(pasted);
            }
          }}
        />
      </div>
      <div className={styles.bar} onClick={(e) => e.stopPropagation()}>
        <div className={styles.toolbar}>{props.toolbar}</div>
        <div className={styles.actions}>
          <IconButton
            icon="paperclip"
            title="Reference a File (@)"
            className={styles.composerButton}
            onClick={() => {
              const glue = text && !/\s$/.test(text) ? " " : "";
              setText(`${text}${glue}@`, text.length + glue.length + 1);
            }}
          />
          <IconButton
            icon="file-image"
            title="Attach Image…"
            className={styles.composerButton}
            onClick={() => imageInput.current?.click()}
          />
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
          <span className={styles.spacer} />
          {props.actions}
        </div>
      </div>
    </div>
  );
}
