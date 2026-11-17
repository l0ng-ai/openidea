import { useState } from "react";
import { tx } from "@/platform/i18n";
import { Checkbox, IconButton, Input, T } from "@/ui";
import {
  addRequestBreakpoint,
  EVENT_GROUPS,
  eventName,
  removeRequestBreakpoint,
  setEventBreakpoint,
  toggleRequestBreakpoint,
  useJsBreakpoints,
} from "./eventBreakpoints";
import { useJsRefusals } from "./refusals";
import styles from "./EventBreakpoints.module.css";

/** The Breakpoints dialog's section for a debugged page: stop on DOM events, timers and requests. */
export function EventBreakpointsSection() {
  const events = useJsBreakpoints((s) => s.events);
  const requests = useJsBreakpoints((s) => s.requests);
  const refused = useJsRefusals((s) =>
    Object.values(s.refused).find((tools) => tools.eventBreakpoints != null),
  )?.eventBreakpoints;
  const [pattern, setPattern] = useState("");
  const add = () => {
    addRequestBreakpoint(pattern);
    setPattern("");
  };
  return (
    <section className={styles.section} aria-label={tx("JavaScript events and requests")}>
      <div className={styles.title}>
        <T>JavaScript Events and Requests</T>
      </div>
      <div className={styles.hint}>
        <T>Stop when a page in the browser handles an event or sends a request.</T>
      </div>
      {refused != null && (
        <div className={styles.refused} role="alert">
          {tx`The debugger of the running page does not take these breakpoints: ${refused}`}
        </div>
      )}
      <div className={styles.groups}>
        {EVENT_GROUPS.map((group) => (
          <div key={group.title} className={styles.group} role="group" aria-label={tx(group.title)}>
            <div className={styles.groupTitle}>{tx(group.title)}</div>
            {group.ids.map((id) => (
              <span key={id} className={styles.row}>
                <Checkbox checked={!!events[id]} onChange={(on) => setEventBreakpoint(id, on)} label={eventName(id)} />
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.groupTitle}>
        <T>Requests whose URL contains</T>
      </div>
      {requests.map((r) => (
        <span key={r.pattern} className={styles.row}>
          <Checkbox checked={r.enabled} onChange={(on) => toggleRequestBreakpoint(r.pattern, on)} label={r.pattern} />
          <IconButton
            icon="minus"
            title="Remove Request Breakpoint"
            size="small"
            onClick={() => removeRequestBreakpoint(r.pattern)}
          />
        </span>
      ))}
      <span className={styles.row}>
        <Input
          mono
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="e.g. /api/"
          aria-label="Part of a request URL"
        />
        <IconButton icon="plus" title="Add Request Breakpoint" size="small" onClick={add} />
      </span>
    </section>
  );
}
