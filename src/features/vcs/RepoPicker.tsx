import { useState } from "react";
import { Select } from "@/ui";
import { repoName, useVcs } from "./store";

/** The repository choice, shown only in projects with multiple Git roots. */
export function RepoPicker({
  id,
  repo,
  onChange,
  className,
}: {
  id?: string;
  repo: string | null;
  onChange: (root: string) => void;
  className?: string;
}) {
  const [roots] = useState(() => useVcs.getState().roots);
  if (roots.length < 2) return null;
  return (
    <Select
      id={id}
      aria-label="Repository"
      className={className}
      value={repo ?? roots[0] ?? null}
      options={roots.map((root) => ({ value: root, label: repoName(root), verbatim: true }))}
      onChange={onChange}
    />
  );
}
