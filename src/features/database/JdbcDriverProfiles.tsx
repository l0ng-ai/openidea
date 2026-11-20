import { useEffect, useState } from "react";
import { call, commands, type DbJdbcDriver } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { Button, Dialog, IconButton, Input, Select, T } from "@/ui";
import { baseName } from "./dumpTools";
import { newSourceId } from "./model";
import styles from "./Database.module.css";

export function useJdbcDrivers(enabled: boolean) {
  const [drivers, setDrivers] = useState<DbJdbcDriver[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    setDrivers(null);
    setError(null);
  }
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void call(commands.dbJdbcDrivers()).then(
      (value) => {
        if (active) setDrivers(value);
      },
      (e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, attempt]);
  const retry = () => {
    setDrivers(null);
    setError(null);
    setAttempt((n) => n + 1);
  };
  return { drivers, setDrivers, error, retry };
}

const blankDriver = (): DbJdbcDriver => ({ id: newSourceId(), name: "", jars: [], className: "", urlTemplate: "" });

export function JdbcDriverProfiles({
  drivers,
  selected,
  onSave,
  onUse,
  onRemove,
  onClose,
}: {
  drivers: DbJdbcDriver[];
  selected: string;
  onSave: (driver: DbJdbcDriver) => void;
  onUse?: (driver: DbJdbcDriver) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const tx = useTx();
  const [selection, setSelection] = useState(
    drivers.some((d) => d.id === selected) ? selected : (drivers[0]?.id ?? ""),
  );
  const [draft, setDraft] = useState<DbJdbcDriver | null>(null);
  const [confirm, setConfirm] = useState<"trust" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classes, setClasses] = useState<string[]>([]);
  const current = drivers.find((d) => d.id === selection);
  const name = current?.name ?? "";
  const set = (patch: Partial<DbJdbcDriver>) => setDraft((d) => d && { ...d, ...patch });
  const classValid =
    !!draft && /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)+$/u.test(draft.className.trim());
  const templateValid = !draft?.urlTemplate || /^jdbc:[^\s:]+:[^\r\n]*$/.test(draft.urlTemplate);
  const valid = !!draft?.name.trim() && !!draft.jars.length && classValid && templateValid;
  const edit = (driver: DbJdbcDriver) => {
    setError(null);
    setClasses([]);
    setDraft({ ...driver, jars: [...driver.jars] });
  };

  const pickJars = async () => {
    setBusy(true);
    setError(null);
    try {
      const { open } = await import("@/platform/dialog");
      const files = await open({
        title: tx("Choose JDBC Driver and Dependency JARs"),
        multiple: true,
        directory: false,
        filters: [{ name: tx("Java archives"), extensions: ["jar"] }],
      });
      if (files && draft) {
        const jars = [...new Set([...draft.jars, ...files])];
        set({ jars });
        const names = await call(commands.dbJdbcDriverClasses(jars));
        setClasses(names);
        if (!draft.className && names.length) set({ className: names[0] });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft || !valid || busy) return;
    setBusy(true);
    setError(null);
    const driver = { ...draft, name: draft.name.trim(), className: draft.className.trim() };
    try {
      await call(commands.dbSaveJdbcDriver(driver));
      onSave(driver);
      setSelection(driver.id);
      setDraft(null);
      setConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call(commands.dbRemoveJdbcDriver(current.id));
      onRemove(current.id);
      setSelection(drivers.find((d) => d.id !== current.id)?.id ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirm(null);
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open
        title={
          draft
            ? drivers.some((d) => d.id === draft.id)
              ? "Edit JDBC Driver"
              : "Add JDBC Driver"
            : "JDBC Driver Profiles"
        }
        onClose={() => {
          if (busy) return;
          if (draft) setDraft(null);
          else onClose();
        }}
        width={640}
        buttons={
          draft
            ? [
                { label: "Cancel", role: "cancel", disabled: busy },
                { label: "Save", role: "default", disabled: busy || !valid, onClick: () => setConfirm("trust") },
              ]
            : [
                { label: "Close", role: "cancel", disabled: busy },
                ...(onUse && current
                  ? [{ label: "Use Driver", role: "default" as const, onClick: () => onUse(current) }]
                  : []),
              ]
        }
      >
        <div className={styles.form}>
          <p className={styles.formFull}>
            <T>Driver profiles are stored locally and shared by all projects.</T>
          </p>
          {draft ? (
            <>
              <label className={styles.formLabel} htmlFor="jdbc-driver-name">
                <T>Name:</T>
              </label>
              <Input
                id="jdbc-driver-name"
                value={draft.name}
                disabled={busy}
                onChange={(e) => set({ name: e.target.value })}
              />
              <span className={styles.formLabel}>
                <T>Driver and dependency JARs:</T>
              </span>
              <div className={styles.jdbcJars}>
                <ul aria-label={tx("Driver and dependency JARs")}>
                  {draft.jars.map((jar) => (
                    <li key={jar}>
                      <span title={jar}>{baseName(jar)}</span>
                      <IconButton
                        icon="close"
                        aria-label={tx`Remove JAR ${jar}`}
                        disabled={busy}
                        onClick={() => {
                          setClasses([]);
                          set({ jars: draft.jars.filter((path) => path !== jar) });
                        }}
                      />
                    </li>
                  ))}
                </ul>
                <Button icon="plus" disabled={busy} onClick={() => void pickJars()}>
                  <T>Add JARs…</T>
                </Button>
              </div>
              <label className={styles.formLabel} htmlFor="jdbc-driver-class">
                <T>Driver class:</T>
              </label>
              <Input
                id="jdbc-driver-class"
                list="jdbc-driver-providers"
                mono
                value={draft.className}
                disabled={busy}
                invalid={!!draft.className && !classValid}
                onChange={(e) => set({ className: e.target.value })}
              />
              <span />
              <span className={styles.formHint}>
                <datalist id="jdbc-driver-providers">
                  {classes.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <T>Select a class declared by the JARs, or enter its fully qualified name.</T>
              </span>
              <label className={styles.formLabel} htmlFor="jdbc-url-template">
                <T>URL template:</T>
              </label>
              <Input
                id="jdbc-url-template"
                mono
                value={draft.urlTemplate}
                disabled={busy}
                invalid={!templateValid}
                onChange={(e) => set({ urlTemplate: e.target.value })}
              />
              <span />
              <span className={styles.formHint}>
                <T>{"Use {host}, {port}, {database} or {file} for fields on the connection form."}</T>
              </span>
            </>
          ) : (
            <>
              <span className={styles.formLabel}>
                <T>JDBC driver profile:</T>
              </span>
              <Select
                aria-label="JDBC driver profiles"
                value={selection}
                options={drivers.map((d) => ({ value: d.id, label: d.name, verbatim: true }))}
                placeholder="No JDBC driver profiles"
                onChange={setSelection}
              />
              <span />
              <div className={styles.formRow}>
                <Button icon="plus" onClick={() => edit(blankDriver())}>
                  <T>Add…</T>
                </Button>
                <Button disabled={!current} onClick={() => current && edit(current)}>
                  <T>Edit…</T>
                </Button>
                <Button disabled={!current} onClick={() => setConfirm("delete")}>
                  <T>Delete…</T>
                </Button>
              </div>
              {current && (
                <dl className={styles.jdbcDetails}>
                  <dt>
                    <T>Driver class:</T>
                  </dt>
                  <dd>{current.className}</dd>
                  <dt>
                    <T>URL template:</T>
                  </dt>
                  <dd>{current.urlTemplate}</dd>
                  <dt>
                    <T>Driver and dependency JARs:</T>
                  </dt>
                  <dd>
                    <ul>
                      {current.jars.map((jar) => (
                        <li key={jar} title={jar}>
                          {baseName(jar)}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </dl>
              )}
            </>
          )}
          {error && (
            <div className={`${styles.formFull} ${styles.bad}`} role="alert">
              {error}
            </div>
          )}
        </div>
      </Dialog>
      {confirm && (
        <Dialog
          open
          title={confirm === "trust" ? "Trust JDBC Driver?" : "Delete JDBC Driver?"}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
          width={520}
          buttons={[
            { label: "Cancel", role: "cancel", disabled: busy, autoFocus: true },
            {
              label: confirm === "trust" ? "Trust and Save" : "Delete",
              role: "default",
              disabled: busy,
              onClick: () => void (confirm === "trust" ? save() : remove()),
            },
          ]}
        >
          <div className={styles.form}>
            <p className={styles.formFull}>
              {confirm === "trust"
                ? tx(
                    "JDBC drivers and their dependency JARs execute local code with your user permissions when connecting. Only import JARs from a source you trust.",
                  )
                : tx`Delete driver profile ${name}? Data sources using it will need another driver profile.`}
            </p>
            {confirm === "trust" && (
              <ul className={styles.formFull}>
                {draft?.jars.map((jar) => (
                  <li key={jar} className={styles.jdbcJarPath}>
                    {jar}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
