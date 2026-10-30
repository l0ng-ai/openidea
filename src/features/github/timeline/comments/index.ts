/**
 * Shared code review comment components (collaboration-tools' chat items and the GitHub
 * plugin's comment / thread factories), used by the timeline and the review diff's inlays:
 *
 * - `ThreadView({ number, thread, variant })`: a review thread, `full` in the timeline,
 *   `compact` in diff inlays (first comment, "… n more replies", last; Reply / Resolve).
 * - `CommentItem(props)`: one comment as a chat item with Edit / Delete / Add reaction.
 * - `CommentEditor(props)`: the Markdown comment field with @mention completion, hints and
 *   submit / cancel / extra buttons (⌘/Ctrl+Enter submits, Escape cancels).
 * - `Reactions` / `AddReactionButton` with `useReactionsState(reactions, onToggle)`.
 * - `ChatItem`, `Tag`, `AuthorLink`: the bare row layout, for new-comment inlays.
 * - `ReviewCommentBody`, `HunkView`, `DiffBox`: a review comment's body with suggested
 *   changes, a read-only hunk, the rounded file box.
 *
 * Every mutation goes through `data/operations.ts`.
 */
export * from "./ChatItem";
export * from "./CommentEditor";
export * from "./CommentItem";
export * from "./DiffHunk";
export * from "./Reactions";
export * from "./SuggestedChange";
export * from "./ThreadView";
