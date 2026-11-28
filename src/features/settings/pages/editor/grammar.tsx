/**
 * Editor › Natural Languages › Grammar: the Grammar inspection's English
 * dialect and the Harper rules it skips (also turned off by the "Disable
 * grammar rule" quick fix).
 */
import { useEffect, useMemo, useState } from "react";
import { useSetting } from "../../components/context";
import { Row, Section } from "../../components/Form";
import { call, commands } from "@/platform/ipc";
import { Checkbox, SearchField, Select, T } from "@/ui";
import type { SelectOption } from "@/ui";
import type { GrammarRule } from "@/bindings";
import type { PageSpec } from "../spec";
import styles from "./Grammar.module.css";

const DIALECTS: SelectOption<string>[] = [
  { value: "american", label: "American" },
  { value: "british", label: "British" },
  { value: "canadian", label: "Canadian" },
  { value: "australian", label: "Australian" },
  { value: "indian", label: "Indian" },
];

function Rules() {
  const [disabled, setDisabled] = useSetting<string[]>("grammar.disabledRules", "global");
  const [rules, setRules] = useState<GrammarRule[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    call(commands.grammarRules())
      .then((r) => live && setRules(r))
      .catch(() => live && setRules([]));
    return () => {
      live = false;
    };
  }, []);
  const off = useMemo(() => new Set(disabled ?? []), [disabled]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rules ?? []).filter(
      (r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  }, [rules, query]);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(name);
    else next.add(name);
    setDisabled([...next].sort());
  };
  return (
    <div className={styles.rules}>
      <SearchField value={query} onChange={setQuery} placeholder="Filter rules" aria-label="Filter rules" />
      {rules === null ? (
        <p className={styles.note}>
          <T>Loading rules…</T>
        </p>
      ) : (
        <ul className={styles.list} aria-label="Grammar rules">
          {shown.map((r) => (
            <li key={r.name}>
              <Checkbox
                checked={!off.has(r.name)}
                onChange={(on) => toggle(r.name, on)}
                label={
                  <span>
                    <span className={styles.name}>{r.name}</span>
                    <span className={styles.description}>{r.description}</span>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GrammarPage() {
  const [dialect, setDialect] = useSetting<string | null>("grammar.dialect", "global");
  return (
    <>
      <Section stackFields>
        <Row label="English dialect" hint="Spellings and usage the rules accept.">
          <Select
            value={dialect || "american"}
            options={DIALECTS}
            onChange={(v) => setDialect(v)}
            aria-label="English dialect"
          />
        </Row>
      </Section>
      <Section title="Rules">
        <p className={styles.note}>
          <T>Harper's English rules, checked on this machine. Spelling is left to Proofreading › Typo.</T>
        </p>
        <Rules />
      </Section>
    </>
  );
}

export const GRAMMAR_PAGE: PageSpec = {
  id: "editor.naturalLanguages.grammar",
  title: "Grammar",
  group: "Editor",
  order: 2,
  keywords: ["grammar", "harper", "proofreading", "dialect", "rules", "style"],
  component: GrammarPage,
};
