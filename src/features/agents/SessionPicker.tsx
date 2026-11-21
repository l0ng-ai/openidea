/**
 * Shared chrome of the per-session MCP and skills pickers: the composer trigger, the popup with its
 * header, filter and footer, and the rows each picker fills it with.
 */
import clsx from "clsx";
import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { executeAction } from "@/platform/actions";
import { formatMessage } from "@/platform/i18n";
import { Icon, IconButton, Popup, SearchField, T, Toggle, type IconName } from "@/ui";
import styles from "./SessionPicker.module.css";

export interface PickerCounts {
  active: number;
  total: number;
  overrides: number;
}

export interface SessionPickerControls {
  close: () => void;
  /** Closes the popup and opens a Settings page. */
  openSettings: (page: string) => void;
}

interface SessionPickerProps {
  icon: IconName;
  /** Visible trigger text: a product name, shown as written in every locale. */
  brand: string;
  /** Translated trigger tooltips; `{active}`, `{total}` and `{overrides}` are filled in. */
  triggerTitles: { plain: string; withOverrides: string };
  triggerAriaLabel: string;
  popupTitle: string;
  settingsTitle: string;
  settingsPage: string;
  counts: PickerCounts;
  search: { placeholder: string; ariaLabel: string; shown: boolean };
  disabled: boolean;
  busy: boolean;
  openRequest: number;
  hideTrigger: boolean;
  /** Reloads the catalog whenever the popup opens; omit when the data is supplied. */
  refresh?: () => void;
  onReset: () => void;
  /** Extra footer lines below the "applies to this session" note. */
  footerNote?: ReactNode;
  /** Receives the popup's filter query and controls. */
  children: (query: string, controls: SessionPickerControls) => ReactNode;
}

export function SessionPicker({
  icon,
  brand,
  triggerTitles,
  triggerAriaLabel,
  popupTitle,
  settingsTitle,
  counts,
  search,
  disabled,
  busy,
  openRequest,
  hideTrigger,
  refresh,
  onReset,
  footerNote,
  children,
  settingsPage,
}: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [seenOpenRequest, setSeenOpenRequest] = useState(openRequest);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLElement | null>(null);
  const setAnchor = (el: HTMLElement | null) => {
    anchor.current = el;
  };

  if (openRequest !== seenOpenRequest) {
    setSeenOpenRequest(openRequest);
    if (openRequest > 0 && !disabled) setOpen(true);
  }

  useEffect(() => {
    if (openRequest > 0 && !disabled) refresh?.();
    // `refresh` is a fresh closure each render; the request itself is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, disabled]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const toggleOpen = () => {
    if (open) close();
    else {
      refresh?.();
      setOpen(true);
    }
  };

  const countLabel =
    counts.total === 0
      ? "0"
      : counts.active === counts.total
        ? String(counts.active)
        : `${counts.active}/${counts.total}`;
  const controls: SessionPickerControls = {
    close: () => setOpen(false),
    openSettings: (page) => {
      setOpen(false);
      void executeAction("file.settings", page);
    },
  };

  return (
    <>
      {hideTrigger ? (
        // Pinned to the composer's bottom-right corner: the popover opens under the box, like its other pickers.
        <span ref={setAnchor} className={styles.hiddenAnchor} aria-hidden />
      ) : (
        <button
          ref={setAnchor}
          type="button"
          disabled={disabled}
          className={styles.trigger}
          title={formatMessage(counts.overrides > 0 ? triggerTitles.withOverrides : triggerTitles.plain, {
            active: counts.active,
            total: counts.total,
            overrides: counts.overrides,
          })}
          aria-label={triggerAriaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <Icon name={icon} size={13} />
          <span className={styles.triggerLabel}>{brand}</span>
          <span className={styles.triggerCount}>{countLabel}</span>
          {counts.overrides > 0 && <span className={styles.overrideDot} aria-hidden />}
        </button>
      )}

      <Popup
        open={open}
        anchor={anchor}
        placement={hideTrigger ? "bottom-end" : "top-start"}
        offset={6}
        onClose={close}
        aria-label={popupTitle}
        className={styles.popup}
      >
        <div className={styles.header}>
          <span className={styles.title}>{popupTitle}</span>
          <div className={styles.headerActions}>
            {counts.overrides > 0 && (
              <button type="button" className={styles.resetBtn} onClick={onReset}>
                <T>Reset</T>
              </button>
            )}
            <IconButton
              icon="settings"
              size="small"
              title={settingsTitle}
              aria-label={settingsTitle}
              onClick={() => controls.openSettings(settingsPage)}
            />
          </div>
        </div>

        {search.shown && (
          <div className={styles.searchWrap}>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={search.placeholder}
              aria-label={search.ariaLabel}
            />
          </div>
        )}

        <div className={styles.list}>{children(query, controls)}</div>

        <div className={styles.footer}>
          <span>
            {busy ? <T>Changes apply on the next message.</T> : <T>Toggles here apply to this session only.</T>}
          </span>
          {footerNote}
        </div>
      </Popup>
    </>
  );
}

export function PickerGroupLabel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className={styles.groupLabel} title={title}>
      {children}
    </div>
  );
}

export function PickerPill({ children }: { children: ReactNode }) {
  return <span className={styles.pill}>{children}</span>;
}

export function PickerSessionPill() {
  return (
    <span className={clsx(styles.pill, styles.pillSession)}>
      <T>Session</T>
    </span>
  );
}

export function PickerInlineLink({
  children,
  ...rest
}: { children: ReactNode } & Pick<ComponentPropsWithoutRef<"button">, "disabled" | "title" | "onClick">) {
  return (
    <button type="button" className={styles.inlineLink} {...rest}>
      {children}
    </button>
  );
}

/** On/off switch plus the status dot every row ends with. */
export function PickerToggle({
  enabled,
  ariaLabel,
  onChange,
}: {
  enabled: boolean;
  ariaLabel: string;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <>
      <Toggle checked={enabled} aria-label={ariaLabel} onChange={onChange} />
      <span className={clsx(styles.dot, enabled && styles.dotOn)} aria-hidden />
    </>
  );
}

/** `{name} {pills}` over an optional one-line detail, with `controls` on the right. */
export function PickerRow({
  name,
  pills,
  sub,
  subTitle,
  controls,
}: {
  name: string;
  pills?: ReactNode;
  sub?: ReactNode;
  subTitle?: string;
  controls: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowInfo}>
        <div className={styles.rowTitle}>
          <span className={styles.name}>{name}</span>
          {pills}
        </div>
        {sub && (
          <span className={styles.sub} title={subTitle}>
            {sub}
          </span>
        )}
      </div>
      <div className={styles.rowControls}>{controls}</div>
    </div>
  );
}

export function PickerEmpty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
