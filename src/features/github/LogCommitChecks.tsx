import { useEffect, useRef, useState, type RefObject } from "react";
import { isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { IconButton } from "@/ui";
import { commitStatusContextsPage } from "./api/requests";
import type { GHCommitStatusRollupContext } from "./api/types";
import { watchLogCommitCheck, type LogCommitCheck } from "./data/logCommitChecks";
import { openInBrowser } from "./data/local";
import { STATUS_ICON } from "./details/model";
import { ChooserPopup } from "./ui/ChooserPopup";

const statuses = {
  SUCCESS: { label: "Checks passed", icon: "success" },
  FAILURE: { label: "Checks failed", icon: "failed" },
  ERROR: { label: "Checks failed", icon: "failed" },
  PENDING: { label: "Checks in progress…", icon: "pending" },
  EXPECTED: { label: "Checks in progress…", icon: "pending" },
} as const satisfies Record<LogCommitCheck["state"], { label: string; icon: keyof typeof STATUS_ICON }>;

function checkPresentation(context: GHCommitStatusRollupContext) {
  if (context.__typename === "StatusContext") {
    return { text: context.context, icon: STATUS_ICON[statuses[context.state].icon] };
  }
  const conclusion = context.conclusion;
  const icon =
    conclusion === "SUCCESS"
      ? "success"
      : conclusion === "NEUTRAL" || conclusion === "SKIPPED"
        ? "skipped"
        : conclusion
          ? "failed"
          : "pending";
  return { text: context.name, detail: context.checkSuite?.workflowRun?.workflow.name, icon: STATUS_ICON[icon] };
}

const checkUrl = (context: GHCommitStatusRollupContext) =>
  context.__typename === "CheckRun" ? context.url : context.targetUrl;

function CheckDetails({
  check,
  revision,
  anchor,
  onClose,
}: {
  check: LogCommitCheck;
  revision: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<GHCommitStatusRollupContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const { root, owner, name } = check.target;
  useEffect(() => {
    let active = true;
    void (async () => {
      let cursor: string | null = null;
      do {
        const page = await commitStatusContextsPage(revision, cursor, 100, { root, owner, name });
        if (!active || !page) break;
        setItems((prev) => [...prev, ...page.nodes]);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (cursor);
    })()
      .catch(() => active && setError(true))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [revision, root, owner, name]);
  return (
    <ChooserPopup
      mode="single"
      aria-label={tx("GitHub Commit Checks")}
      anchor={anchor}
      placement="top-start"
      items={items}
      getKey={(context) => `${checkPresentation(context).text}\0${checkUrl(context) ?? ""}`}
      present={checkPresentation}
      onChoose={(context) => {
        const url = checkUrl(context);
        if (url && /^https?:\/\//i.test(url)) void openInBrowser(url);
      }}
      loading={loading}
      error={error ? tx("Could not load commit checks") : null}
      height={Math.min(300, 40 + Math.max(1, items.length) * 28)}
      onClose={onClose}
    />
  );
}

export function LogCommitChecks({ root, revision }: { root: string; revision: string }) {
  const [check, setCheck] = useState<LogCommitCheck | null>(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isTauri() || !/^[a-f0-9]{40}$/i.test(revision)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const load = () => {
      unsubscribe?.();
      unsubscribe = watchLogCommitCheck(root, revision, ({ check, expires }) => {
        setCheck(check);
        if (check) timer = setTimeout(load, Math.max(0, expires - Date.now()));
      });
    };
    load();
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [root, revision]);

  if (!check) return null;
  const status = statuses[check.state];
  return (
    <>
      <IconButton
        ref={anchor}
        size="small"
        icon={STATUS_ICON[status.icon]}
        title={status.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") e.stopPropagation();
        }}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <CheckDetails
          key={`${check.target.owner}/${check.target.name}`}
          check={check}
          revision={revision}
          anchor={anchor}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
