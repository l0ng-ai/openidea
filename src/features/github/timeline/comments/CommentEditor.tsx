/**
 * The comment text field (collaboration-tools' `CodeReviewCommentTextFieldFactory` with
 * `CommentInputActionsComponentFactory`): an optional avatar, a growing Markdown field with
 * @mention completion (the repository's mentionable users, `GHViewModelMentionCompletion`),
 * then the hints ("{Enter} to add new line", the submit hint) and the buttons (Cancel, extra
 * actions, the primary one). ⌘/Ctrl+Enter submits, Escape cancels.
 *
 *   <CommentEditor submitLabel="Reply" submitHint={tx`${submitShortcut()} to reply`}
 *     onSubmit={(text) => replyToComment(n, id, text)} />
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { tx, useTx } from "@/platform/i18n";
import { formatBinding, isMacHost } from "@/platform/keymap";
import { Button, Popup } from "@/ui";
import { errorMessage } from "../../api/client";
import type { GHUser } from "../../api/types";
import { useGhRepository, useRepositoryList } from "../../data/repository";
import { Avatar } from "../../ui/Avatar";
import { filterMentions, insertMention, mentionQuery } from "../model";
import { avatarSize, type ChatItemVariant } from "./ChatItem";
import styles from "./comments.module.css";

/** The submit shortcut as hints show it (`CommentInputActionsComponentFactory.submitShortcutText`). */
export const submitShortcut = () => formatBinding(isMacHost() ? "Meta+Enter" : "Ctrl+Enter");
/** The new-line shortcut (Enter). */
const newLineShortcut = () => formatBinding("Enter");

export interface CommentEditorAction {
  label: string;
  onClick: () => void | Promise<unknown>;
  disabled?: boolean;
}

export interface CommentEditorProps {
  initialText?: string;
  /** The primary button: "Comment", "Reply", "Save Changes"… */
  submitLabel: string;
  /** "⌘⏎ to comment" and the like (translated by the caller). */
  submitHint: string;
  /** Sends the text; the field keeps it when this rejects (the error shows under it). */
  onSubmit: (text: string) => Promise<unknown>;
  /** Shows Cancel (and Escape cancels). */
  onCancel?: () => void;
  /** Escape only, no Cancel button (a diff's new comment: its gutter icon discards it). */
  noCancelButton?: boolean;
  /** Buttons before the primary one ("Resolve" of the reply box). */
  extraActions?: CommentEditorAction[];
  /** The author avatar on the left: the current user's (FULL / COMPACT inputs). */
  showAvatar?: boolean;
  variant?: ChatItemVariant;
  placeholder?: string;
  autoFocus?: boolean;
  /** Empty the field after a successful submit (new comments and replies). */
  clearOnSubmit?: boolean;
  /** Allows submitting an empty text (editing a review body to nothing is not allowed). */
  allowEmpty?: boolean;
  /** Called as the text changes (a diff's new comment keeps its draft). */
  onTextChange?: (text: string) => void;
  /** Changing it moves the focus into the field again (a new comment requested twice). */
  focusRequest?: number;
}

export function CommentEditor({
  initialText = "",
  submitLabel,
  submitHint,
  onSubmit,
  onCancel,
  noCancelButton,
  extraActions = [],
  showAvatar,
  variant = "full",
  placeholder,
  autoFocus,
  clearOnSubmit,
  allowEmpty,
  onTextChange,
  focusRequest,
}: CommentEditorProps) {
  const t = useTx();
  const me = useGhRepository((s) => s.connection?.currentUser ?? null);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  // The mentionable users load once per repository, on the first editor.
  const mentionable = useRepositoryList("mentionableUsers").items;
  const matches = mention ? filterMentions(mentionable, mention.query) : [];
  const ref = useRef<HTMLTextAreaElement>(null);
  const [field, setField] = useState<HTMLDivElement | null>(null);

  // Grow with the text, like IntelliJ's comment field.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus, focusRequest]);

  const canSubmit = !busy && (allowEmpty || !!text.trim());

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      if (clearOnSubmit) {
        setText("");
        onTextChange?.("");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const runExtra = async (a: CommentEditorAction) => {
    setBusy(true);
    setError(null);
    try {
      await a.onClick();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const updateMention = (value: string, caret: number) => {
    const m = mentionQuery(value, caret);
    setMention(m);
    setActive(0);
  };

  const pick = (u: GHUser) => {
    const el = ref.current;
    if (!el || !mention) return;
    const r = insertMention(text, mention.start, el.selectionStart, u.login);
    setText(r.text);
    onTextChange?.(r.text);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + d + matches.length) % matches.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pick(matches[Math.min(active, matches.length - 1)]!);
        return;
      }
    }
    if (e.key === "Escape") {
      if (mention) {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
      } else if (onCancel) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
      return;
    }
    if (e.key === "Enter" && (isMacHost() ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
    }
  };

  return (
    <div className={styles.editorRow} style={{ ["--gap" as string]: variant === "full" ? "14px" : "10px" }}>
      {showAvatar && me && <Avatar url={me.avatarUrl} name={me.name || me.login} size={avatarSize(variant)} />}
      <div className={styles.editor}>
        <div ref={setField} className={styles.field}>
          <textarea
            ref={ref}
            className={styles.textarea}
            rows={1}
            value={text}
            disabled={busy}
            placeholder={t(placeholder)}
            aria-label={placeholder ? t(placeholder) : t(submitLabel)}
            onChange={(e) => {
              setText(e.target.value);
              onTextChange?.(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              if (mention) updateMention(el.value, el.selectionStart);
            }}
            onBlur={() => setTimeout(() => setMention(null), 150)}
            onKeyDown={onKeyDown}
          />
          {mention && (
            <MentionPopup
              anchor={field}
              matches={matches}
              active={active}
              onPick={pick}
              onClose={() => setMention(null)}
            />
          )}
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.editorFooter}>
          <div className={styles.hints}>
            <span>{submitHint}</span>
            <span>{tx`${newLineShortcut()} to add new line`}</span>
          </div>
          <div className={styles.buttons}>
            {onCancel && !noCancelButton && (
              <Button disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
            )}
            {extraActions.map((a) => (
              <Button key={a.label} disabled={busy || a.disabled} onClick={() => void runExtra(a)}>
                {t(a.label)}
              </Button>
            ))}
            <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
              {t(submitLabel)}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The completion list of the `@query` being typed. */
function MentionPopup(props: {
  anchor: HTMLElement | null;
  matches: GHUser[];
  active: number;
  onPick: (u: GHUser) => void;
  onClose: () => void;
}) {
  const { matches } = props;
  if (!matches.length) return null;
  return (
    <Popup
      open
      anchor={props.anchor}
      onClose={props.onClose}
      placement="bottom-start"
      autoFocus={false}
      restoreFocus={false}
      aria-label="Mentions"
    >
      <div className={styles.mentions} role="listbox">
        {matches.map((u, i) => (
          <div
            key={u.id || u.login}
            role="option"
            aria-selected={i === props.active}
            className={styles.mention}
            data-active={i === props.active || undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              props.onPick(u);
            }}
          >
            <Avatar url={u.avatarUrl} name={u.login} size={16} title={null} />
            <span>{u.login}</span>
            {u.name && <span className={styles.secondary}>{u.name}</span>}
          </div>
        ))}
      </div>
    </Popup>
  );
}
