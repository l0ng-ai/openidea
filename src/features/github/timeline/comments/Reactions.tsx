/**
 * Reactions of a description, comment or review comment (`GHReactionsComponentFactory`,
 * `GHReactionsPickerComponentFactory`): a pill per reaction (emoji, count, outlined when
 * the viewer reacted, tooltip "{users} reacted with '{name}' emoji") that toggles the
 * viewer's reaction, then a pill opening the picker; and the "Add reaction" header button.
 * The viewer's toggle shows at once and is undone when the request fails.
 */
import { useState } from "react";
import { tx } from "@/platform/i18n";
import { IconButton, Popup, tooltipAttrs } from "@/ui";
import type { GHReaction, GHReactionContent } from "../../api/types";
import { useGhRepository } from "../../data/repository";
import { groupReactions, presentableName, REACTIONS, toggleReactionLocally } from "../model";
import styles from "./comments.module.css";

export type ToggleReaction = (content: GHReactionContent, add: boolean) => Promise<unknown>;

const reactionOf = (c: GHReactionContent) => REACTIONS.find((r) => r.content === c)!;

/** What `Reactions` and `AddReactionButton` of one subject share. */
export interface ReactionsState {
  shown: readonly GHReaction[];
  toggle: (content: GHReactionContent) => void;
  meId: string | null;
}

/** The reactions shown: the given ones with the viewer's pending toggle applied. */
export function useReactionsState(reactions: readonly GHReaction[], onToggle: ToggleReaction): ReactionsState {
  const me = useGhRepository((s) => s.connection?.currentUser ?? null);
  // The local toggle applies until the reactions are reloaded.
  const [local, setLocal] = useState<{ base: readonly GHReaction[]; value: GHReaction[] } | null>(null);
  const shown = local && local.base === reactions ? local.value : reactions;
  const toggle = (content: GHReactionContent) => {
    if (!me) return;
    const add = !groupReactions(shown, me.id).find((r) => r.content === content)?.isReactedByCurrentUser;
    setLocal({ base: reactions, value: toggleReactionLocally(shown, content, me, add) });
    onToggle(content, add).catch(() => setLocal(null));
  };
  return { shown, toggle, meId: me?.id ?? null };
}

/** The emoji picker under `anchor`. */
function ReactionPicker({
  anchor,
  reacted,
  onPick,
  onClose,
}: {
  anchor: Element | null;
  reacted: ReadonlySet<GHReactionContent>;
  onPick: (c: GHReactionContent) => void;
  onClose: () => void;
}) {
  return (
    <Popup open anchor={anchor} onClose={onClose} placement="bottom-start" aria-label={tx("Add reaction")}>
      <div className={styles.picker}>
        {REACTIONS.map((r) => (
          <button
            key={r.content}
            type="button"
            className={styles.pickerEmoji}
            data-own={reacted.has(r.content) || undefined}
            aria-label={r.name}
            {...tooltipAttrs(r.name)}
            onClick={() => {
              onPick(r.content);
              onClose();
            }}
          >
            {r.emoji}
          </button>
        ))}
      </div>
    </Popup>
  );
}

export interface ReactionsProps {
  /** `useReactionsState` of the subject (shared with its `AddReactionButton`). */
  state: ReactionsState;
  /** The viewer may react (`viewerCanReact`); otherwise the pills only show. */
  canReact: boolean;
}

/** The reactions row; nothing when there are none. */
export function Reactions({ state, canReact }: ReactionsProps) {
  const { shown, toggle, meId } = state;
  const [picker, setPicker] = useState<Element | null>(null);
  const groups = groupReactions(shown, meId);
  if (!groups.length) return null;
  return (
    <div className={styles.reactions}>
      {groups.map((g) => {
        const r = reactionOf(g.content);
        const users = g.users.map((u) => presentableName(u)).join(", ");
        const name = r.name;
        return (
          <button
            key={g.content}
            type="button"
            className={styles.pill}
            data-own={g.isReactedByCurrentUser || undefined}
            disabled={!canReact}
            {...tooltipAttrs(tx`${users} reacted with '${name}' emoji`)}
            onClick={() => toggle(g.content)}
          >
            <span className={styles.emoji}>{r.emoji}</span>
            {g.users.length}
          </button>
        );
      })}
      {canReact && (
        <button
          type="button"
          className={styles.pill}
          aria-label={tx("Add reaction")}
          {...tooltipAttrs(tx("Add reaction"))}
          onClick={(e) => setPicker(e.currentTarget)}
        >
          <span className={styles.emoji}>☺</span>+
        </button>
      )}
      {picker && (
        <ReactionPicker
          anchor={picker}
          reacted={new Set(groups.filter((g) => g.isReactedByCurrentUser).map((g) => g.content))}
          onPick={toggle}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** The header's "Add reaction" button: the picker for the same reactions. */
export function AddReactionButton({ state }: { state: ReactionsState }) {
  const { shown, toggle, meId } = state;
  const [anchor, setAnchor] = useState<Element | null>(null);
  const reacted = new Set(
    groupReactions(shown, meId)
      .filter((g) => g.isReactedByCurrentUser)
      .map((g) => g.content),
  );
  return (
    <>
      <IconButton icon="add-emoji" title="Add reaction" size="small" onClick={(e) => setAnchor(e.currentTarget)} />
      {anchor && <ReactionPicker anchor={anchor} reacted={reacted} onPick={toggle} onClose={() => setAnchor(null)} />}
    </>
  );
}
