import { useState } from "react";
import type { Commit } from "@/bindings";
import { Dialog, List, SearchField } from "@/ui";
import { openDialog } from "./dialogs";
import { commitKey } from "./multiRoot";

export function chooseLogCommit(commits: Commit[], title: string): Promise<Commit | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <CommitChooser
        commits={commits}
        title={title}
        onDone={(commit) => {
          close();
          resolve(commit);
        }}
      />
    ));
  });
}

function CommitChooser({
  commits,
  title,
  onDone,
}: {
  commits: Commit[];
  title: string;
  onDone: (commit: Commit | null) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = commits.filter((c) =>
    `${c.id} ${c.summary} ${c.author}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <Dialog open title={title} onClose={() => onDone(null)} width={520}>
      <SearchField value={query} onChange={setQuery} placeholder="Search commits" aria-label="Search commits" />
      <div style={{ height: 260, display: "flex" }}>
        <List
          items={shown}
          getKey={commitKey}
          renderItem={(c) => `${c.shortId}  ${c.summary} — ${c.author}`}
          onActivate={onDone}
          rowHeight={26}
          aria-label={title}
        />
      </div>
    </Dialog>
  );
}
