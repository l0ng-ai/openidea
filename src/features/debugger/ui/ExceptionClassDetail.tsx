/** Details of the Breakpoints dialog's Java exception breakpoints: "Any exception" and one per class. */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Button, Checkbox, Icon, Input, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { anyException, setAnyException, useExceptionBreakpoints } from "../breakpoints/exceptions";
import { removeExceptionClass, updateExceptionClass, type ExceptionClassEntry } from "../breakpoints/exceptionClasses";
import styles from "./Overlays.module.css";

function Notifications({
  caught,
  uncaught,
  onChange,
}: {
  caught: boolean;
  uncaught: boolean;
  onChange: (kind: "caught" | "uncaught", on: boolean) => void;
}) {
  return (
    <div className={styles.field} role="group" aria-label={tx("Suspend on")}>
      <span className={styles.label}>
        <T>Suspend on</T>
      </span>
      <span className={styles.exceptionGroup}>
        <Checkbox checked={caught} onChange={(on) => onChange("caught", on)} label="Caught exception" />
        <Checkbox checked={uncaught} onChange={(on) => onChange("uncaught", on)} label="Uncaught exception" />
      </span>
    </div>
  );
}

/** A field IDEA has for Java exception breakpoints that java-debug cannot honour: shown disabled. */
function UnsupportedField({ label, inputLabel }: { label: string; inputLabel: string }) {
  return (
    <div
      className={styles.unsupportedField}
      data-tooltip="Not available with java-debug: it suspends at every exception it reports, so a condition or a catch location cannot let one pass."
    >
      <Checkbox checked={false} disabled onChange={() => undefined} label={label} />
      <Input mono disabled value="" aria-label={inputLabel} />
    </div>
  );
}

export function AnyExceptionDetail() {
  const known = useExceptionBreakpoints((s) => s.known);
  const choices = useExceptionBreakpoints((s) => s.choices);
  const { caught, uncaught } = anyException(known, choices);
  return (
    <div className={styles.detail}>
      <div className={styles.bpTitle}>
        <Icon name="breakpoint-exception" size={14} />
        <span className={styles.bpFile}>
          <T>Any exception</T>
        </span>
      </div>
      <div className={styles.statusLine}>
        <T>Stops at every exception thrown in a Java debug session.</T>
      </div>
      <Notifications caught={caught} uncaught={uncaught} onChange={setAnyException} />
    </div>
  );
}

export function ExceptionClassDetail({
  bp,
  commitRef,
}: {
  bp: ExceptionClassEntry;
  commitRef: MutableRefObject<(() => void) | null>;
}) {
  const [className, setClassName] = useState(bp.className);
  const [filters, setFilters] = useState(bp.classFilters);
  const draft = useRef({ className, filters });
  useEffect(() => {
    draft.current = { className, filters };
    commitRef.current = () =>
      updateExceptionClass(bp.id, { className: draft.current.className.trim(), classFilters: draft.current.filters });
    return () => {
      commitRef.current = null;
    };
  });
  const title = bp.className || tx("No class chosen");
  return (
    <div className={styles.detail}>
      <div className={styles.bpTitle}>
        <Icon name="breakpoint-exception" size={14} />
        <span className={styles.bpFile} title={title}>
          {title}
        </span>
        <Button size="small" variant="ghost" onClick={() => removeExceptionClass(bp.id)}>
          <T>Remove</T>
        </Button>
      </div>
      <Checkbox checked={bp.enabled} onChange={(enabled) => updateExceptionClass(bp.id, { enabled })} label="Enabled" />
      <label className={styles.field}>
        <span className={styles.label}>
          <T>Exception class</T>
        </span>
        <Input
          mono
          value={className}
          onChange={(e) => setClassName(e.target.value)}
          onBlur={() => updateExceptionClass(bp.id, { className: className.trim() })}
          placeholder="java.lang.IllegalStateException, com.example.Outer$Failure"
          data-autofocus={bp.className ? undefined : ""}
          aria-label="Exception class name"
        />
      </label>
      <Notifications
        caught={bp.caught}
        uncaught={bp.uncaught}
        onChange={(kind, on) => updateExceptionClass(bp.id, { [kind]: on })}
      />
      <UnsupportedField label="Condition" inputLabel={tx("Condition expression")} />
      <div className={styles.field}>
        <Checkbox
          checked={bp.classFiltersEnabled}
          onChange={(classFiltersEnabled) => updateExceptionClass(bp.id, { classFiltersEnabled })}
          label="Class filters"
        />
        <Input
          mono
          value={filters}
          disabled={!bp.classFiltersEnabled}
          onChange={(e) => setFilters(e.target.value)}
          onBlur={() => updateExceptionClass(bp.id, { classFilters: filters })}
          placeholder="com.example.* -com.example.generated.*"
          aria-label="Class filter patterns"
        />
        <span className={styles.statusLine}>
          <T>Where the exception is thrown. Put - before a pattern to exclude it.</T>
        </span>
      </div>
      <UnsupportedField label="Catch class filters" inputLabel={tx("Catch class filter patterns")} />
    </div>
  );
}
