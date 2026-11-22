import type { TodoItem } from "@/platform/todo";

export interface TodoReviewFile {
  path: string;
  text: string;
  items: TodoItem[];
  open(item: TodoItem, focus: boolean): Promise<void>;
}

export interface TodoReviewSkippedFile {
  path: string;
  reason: string;
  detail?: string;
}

export interface TodoReview {
  kind: "pending" | "committed";
  subject: string;
  files: readonly TodoReviewFile[];
  skipped: readonly TodoReviewSkippedFile[];
}

let opener: ((review: TodoReview) => void) | undefined;

export function provideTodoReview(open: (review: TodoReview) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = undefined;
  };
}

export function showTodoReview(review: TodoReview): boolean {
  if (!opener) return false;
  opener(review);
  return true;
}
