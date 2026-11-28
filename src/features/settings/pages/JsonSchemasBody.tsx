/**
 * Languages & Frameworks › JSON Schema Mappings: schemas (a URL or a project file) for the JSON and
 * YAML files matching paths or patterns. The backend sends them to the JSON and YAML language servers.
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { choosePath } from "@/platform/choosePath";
import { tx } from "@/platform/i18n";
import { relativePath, useProject } from "@/platform/project";
import { IconButton, Input, List, T } from "@/ui";
import { GlobListEditor, Row, Section } from "../components/Form";
import { useSetting } from "../components/context";
import { validateJsonSchemas, type JsonSchemaMappingValid as JsonSchemaMapping } from "../model/schema";
import { ListToolbar, moved } from "./ScopesBody";
import styles from "./Workflow.module.css";
import own from "./Scopes.module.css";
import sdk from "../languages/Sdk.module.css";

/** A name not taken yet: `Mapping`, `Mapping 2`, … */
function freshSchemaName(taken: readonly string[]): string {
  const base = tx("Mapping");
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.includes(name)) return name;
  }
}

export function JsonSchemasEditor() {
  const [raw, setRaw] = useSetting<unknown>("jsonSchemas");
  const root = useProject((s) => s.project?.root);
  const mappings = validateJsonSchemas(raw);
  const [selected, setSelected] = useState(0);
  const index = mappings.length ? Math.min(selected, mappings.length - 1) : -1;
  const current = mappings[index];
  const nameId = useId();
  const schemaId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const focusNew = useRef(false);
  useLayoutEffect(() => {
    if (!focusNew.current) return;
    focusNew.current = false;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [mappings.length]);
  const set = (next: JsonSchemaMapping[]) => setRaw(next);
  const update = (patch: Partial<JsonSchemaMapping>) =>
    set(mappings.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const names = mappings.map((m) => m.name);
  const nameClash = !!current && names.filter((n) => n === current.name).length > 1;

  return (
    <div className={own.scopeLayout}>
      <div className={clsx(styles.tableBox, own.scopePane)}>
        <ListToolbar
          label="JSON schema mappings actions"
          index={index}
          count={mappings.length}
          onAdd={() => {
            focusNew.current = true;
            set([...mappings, { name: freshSchemaName(names), schema: "", files: [] }]);
            setSelected(mappings.length);
          }}
          onRemove={() => set(mappings.filter((_, i) => i !== index))}
          onMove={(d) => {
            const next = moved(mappings, index, d);
            if (next) {
              set(next);
              setSelected(index + d);
            }
          }}
        />
        <List
          aria-label={tx("JSON schema mappings")}
          className={own.scopeList}
          items={mappings}
          activeIndex={index}
          onActiveChange={setSelected}
          getKey={(_, i) => String(i)}
          renderItem={({ name, schema }) => (
            <span className={own.scopeName} title={schema ? `${name}\n${schema}` : name}>
              {name}
            </span>
          )}
          empty={
            <div className={own.scopeEmpty}>
              <T>No schema mappings. Click + to add one.</T>
            </div>
          }
        />
      </div>
      {current && (
        <Section title="Mapping">
          <Row label="Name" htmlFor={nameId}>
            <Input
              id={nameId}
              ref={nameInput}
              className={own.scopeInput}
              value={current.name}
              invalid={nameClash || !current.name.trim()}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Row>
          <Row
            label="Schema file or URL"
            htmlFor={schemaId}
            hint="A URL, or a path relative to the project. The schema's own $schema picks the JSON Schema version."
          >
            <span className={sdk.pathRow}>
              <Input
                id={schemaId}
                mono
                className={sdk.pathInput}
                value={current.schema}
                invalid={!current.schema.trim()}
                placeholder="schemas/app.schema.json"
                onChange={(e) => update({ schema: e.target.value })}
              />
              <IconButton
                icon="folder-open"
                size="small"
                title="Browse…"
                onClick={async () => {
                  const p = await choosePath({ directory: false, title: tx("Select Schema File"), defaultPath: root });
                  if (p) update({ schema: root ? relativePath(root, p) : p });
                }}
              />
            </span>
          </Row>
          <Row
            label="Files"
            stacked
            hint="Paths or glob patterns, relative to the project: config/*.json, **/*.app.yaml. Wins over the built-in mapping for the same files."
          >
            <GlobListEditor
              value={current.files}
              onChange={(files) => update({ files })}
              placeholder="config/*.json"
              emptyText="No files"
              itemLabel="File or pattern"
              aria-label="Files"
              fullWidth
            />
          </Row>
        </Section>
      )}
    </div>
  );
}
