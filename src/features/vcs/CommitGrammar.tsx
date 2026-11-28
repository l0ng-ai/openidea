/**
 * Proofreading › Grammar for the commit message box (a text area, not an
 * editor): the problems listed under it, each with Harper's first fix and
 * "Disable rule".
 */
import { useEffect, useState } from "react";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { GRAMMAR_INSPECTION, inspectionProfile } from "@/platform/inspections";
import { useProject } from "@/platform/project";
import { disableGrammarRule, fixLabel } from "@/editor/lsp/grammar";
import type { GrammarProblem, Pos, Range } from "@/bindings";
import { T } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./CommitView.module.css";

const CHECK_DELAY = 600;
/** Problems listed at most. */
const MAX_SHOWN = 5;

/** The string offset of a line / UTF-16 column position (JS strings are UTF-16). */
export function offsetAt(text: string, pos: Pos): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(text.length, offset + pos.col);
}

const isEmpty = (r: Range) => r.start.line === r.end.line && r.start.col === r.end.col;

export function CommitGrammar({ message, onChange }: { message: string; onChange: (message: string) => void }) {
  // The problems of the message they were found in: stale ones are not shown.
  const [checked, setChecked] = useState<{ message: string; problems: GrammarProblem[] } | null>(null);
  const settings = useProject((s) => s.settings);
  const enabled = inspectionProfile()[GRAMMAR_INSPECTION]?.enabled !== false;
  useEffect(() => {
    if (!enabled || !isTauri() || !message.trim()) return;
    const id = nextRequestId();
    let live = true;
    const timer = setTimeout(() => {
      call(commands.grammarCheckText(message, id))
        .then((problems) => live && setChecked({ message, problems }))
        .catch((e) => {
          if (!isCancelled(e)) console.debug("[grammar]", e);
        });
    }, CHECK_DELAY);
    return () => {
      live = false;
      clearTimeout(timer);
      void commands.cancelRequest(id);
    };
  }, [message, enabled, settings?.grammar, settings?.spelling]);
  const problems = enabled && checked?.message === message ? checked.problems : [];
  if (!problems.length) return null;
  const hidden = problems.length - MAX_SHOWN;
  return (
    <div className={styles.inspections} role="status" aria-label="Grammar">
      {problems.slice(0, MAX_SHOWN).map((p, i) => {
        const fix = p.fixes[0];
        const from = offsetAt(message, p.range.start);
        const to = offsetAt(message, p.range.end);
        return (
          <div key={`${from}:${p.rule}:${i}`}>
            <q>{p.text}</q> {p.message}
            {fix && (
              <button
                type="button"
                className={styles.inspectionFix}
                onClick={() => {
                  if (message.slice(from, to) !== p.text) return;
                  const start = offsetAt(message, fix.range.start);
                  const end = offsetAt(message, fix.range.end);
                  onChange(message.slice(0, start) + fix.text + message.slice(end));
                }}
              >
                {fixLabel(p, { text: fix.text, empty: isEmpty(fix.range) })}
              </button>
            )}
            <button type="button" className={styles.inspectionFix} onClick={() => void disableGrammarRule(p.rule)}>
              <T>Disable rule</T>
            </button>
          </div>
        );
      })}
      {hidden > 0 && <div>{tx`${hidden} more grammar problems`}</div>}
    </div>
  );
}
