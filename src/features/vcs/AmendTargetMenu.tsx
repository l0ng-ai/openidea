import { useEffect, useRef, useState } from "react";
import { executeActionFrom } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { Button, Popup, SelectListbox, T, tooltipAttrs, type SelectOption } from "@/ui";
import { loadAmendTargets, SELECT_AMEND_TARGET, type AmendTargets } from "./amendTargets";
import { useCommit } from "./commitStore";
import styles from "./CommitView.module.css";

const LAST_COMMIT = "last";

export function AmendTargetMenu({ root }: { root: string }) {
  const target = useCommit((s) => s.amendTarget);
  const busy = useCommit((s) => !!s.operation);
  const anchor = useRef<HTMLButtonElement>(null);
  const [initialQuery, setInitialQuery] = useState<string | null>(null);
  const [result, setResult] = useState<{ root: string; targets: AmendTargets | null } | null>(null);
  const open = initialQuery !== null;

  useEffect(() => {
    if (!open) return;
    let current = true;
    void loadAmendTargets(root).then(
      (targets) => {
        if (current) setResult({ root, targets });
      },
      () => {
        if (current) setResult({ root, targets: null });
      },
    );
    return () => {
      current = false;
    };
  }, [open, root]);

  const close = () => setInitialQuery(null);
  const openPicker = (query = "") => {
    setResult(null);
    setInitialQuery(query);
  };
  const available = result?.root === root ? result.targets : undefined;
  const options: SelectOption[] = [
    {
      value: LAST_COMMIT,
      label: "Amend Last Commit",
      emphasized: true,
      detail: available?.latest?.summary,
      verbatimDetail: true,
    },
    ...(available?.earlier.map(({ commit }) => ({
      value: commit.id,
      label: commit.summary || commit.shortId,
      verbatim: true,
    })) ?? []),
  ];

  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="small"
        className={styles.amendTarget}
        icon="chevron-down"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tx("Choose Commit to Amend")}
        disabled={busy}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(event) => {
          if (open || event.nativeEvent.isComposing) return;
          const key = event.key;
          if (key === "ArrowDown" || key === "ArrowUp") {
            event.preventDefault();
            openPicker();
          } else if (key.length === 1 && key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            openPicker(key);
          }
        }}
        {...tooltipAttrs(target ? target.commit.summary : tx("Choose Commit to Amend"), undefined, true)}
      >
        {target && <span>{target.commit.summary || target.commit.shortId}</span>}
      </Button>
      <Popup open={open} anchor={anchor} onClose={close} role="presentation" className={styles.amendPicker}>
        <SelectListbox
          value={target?.commit.id ?? LAST_COMMIT}
          options={options}
          searchable
          searchLabel="Search commits"
          highlightMatches
          initialQuery={initialQuery ?? undefined}
          aria-label="Choose Commit to Amend"
          listClassName={styles.amendPickerRows}
          empty={
            available && (
              <span className={styles.amendPickerStatus}>
                <T>No matches</T>
              </span>
            )
          }
          onChoose={(value) => {
            close();
            const earlier = available?.earlier.find((option) => option.commit.id === value);
            if (value === LAST_COMMIT || earlier) void executeActionFrom("menu", SELECT_AMEND_TARGET, earlier);
          }}
        />
        {available == null && (
          <div role="status" className={styles.amendPickerStatus}>
            <T>{available === null ? "Could not load earlier commits" : "Loading commits…"}</T>
          </div>
        )}
      </Popup>
    </>
  );
}
