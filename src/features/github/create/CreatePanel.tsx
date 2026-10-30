/**
 * The "New Pull Request at {repo}" tab (IntelliJ's `GHPRCreateComponentFactory`): a
 * vertical splitter with the merge direction and the commits and changes above, and the
 * title and description, reviewers / assignees / labels, the status line and the
 * "Create Pull Request" option button (with "Create Draft Pull Request") below.
 *
 * Contract: `CreatePanel()` takes no props and renders inside the New Pull Request tab
 * while the tool window is connected. Its state (`store.ts`) lives as long as the tab.
 */
import { useEffect, useRef, useState } from "react";
import { useVcs } from "@/features/vcs/store";
import { tx } from "@/platform/i18n";
import {
  Button,
  Icon,
  IconButton,
  Input,
  Menu,
  Popup,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  T,
  type MenuItem,
} from "@/ui";
import { openPullRequest } from "../toolwindow/open";
import { ChangesPanel } from "./ChangesPanel";
import { DirectionSelector } from "./DirectionSelector";
import { MetadataGrid } from "./MetadataGrid";
import {
  canCreate,
  createFromForm,
  initCreate,
  onRepositoryChanged,
  refreshBranchesState,
  resetCreate,
  setDescription,
  setTitle,
  useCreatePr,
} from "./store";
import styles from "./Create.module.css";

export function CreatePanel() {
  const ready = useCreatePr((s) => s.ready);
  const initError = useCreatePr((s) => s.initError);
  useEffect(() => {
    void initCreate();
  }, []);
  // Commits follow the repository (a new commit, a push, a fetch).
  useEffect(
    () =>
      useVcs.subscribe((s, prev) => {
        if (s.version !== prev.version) void onRepositoryChanged();
      }),
    [],
  );
  if (initError)
    return (
      <div className={styles.centered}>
        <div className={styles.errorText}>{initError}</div>
        <Button
          size="small"
          onClick={() => {
            resetCreate();
            void initCreate();
          }}
        >
          <T>Retry</T>
        </Button>
      </div>
    );
  if (!ready)
    return (
      <div className={styles.centered}>
        <Spinner size={14} />
      </div>
    );
  return (
    <SplitGroup orientation="vertical" id="github-create-pull-request" className={styles.root}>
      <SplitPanel id="top" defaultSize="50%" minSize="90px">
        <div className={styles.top}>
          <DirectionSelector />
          <div className={styles.changesBox}>
            <ChangesPanel />
          </div>
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="bottom" defaultSize="50%" minSize="160px">
        <div className={styles.bottom}>
          <TextPanel />
          <MetadataGrid />
          <div className={styles.footer}>
            <StatusLine />
            <CreateButton />
          </div>
        </div>
      </SplitPanel>
    </SplitGroup>
  );
}

/** `CodeReviewTitleDescriptionComponentFactory`: the title and description editors. */
function TextPanel() {
  const title = useCreatePr((s) => s.title);
  const description = useCreatePr((s) => s.description);
  const templateLoading = useCreatePr((s) => s.templateLoading);
  return (
    <div className={styles.text}>
      <Input
        className={styles.titleInput}
        aria-label="Title"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className={styles.descriptionBox}>
        <textarea
          className={styles.description}
          aria-label={tx("Description")}
          placeholder={tx("Description")}
          value={description}
          disabled={templateLoading}
          onChange={(e) => setDescription(e.target.value)}
        />
        {templateLoading && (
          <span className={styles.templateSpinner}>
            <Spinner size={12} />
          </span>
        )}
      </div>
    </div>
  );
}

/** "Details": the error in a popup above the link. */
function ErrorDetails({ title, error }: { title: string; error: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" className={styles.textLink} onClick={() => setOpen(true)}>
        <T>Details</T>
      </button>
      {open && (
        <Popup
          open
          anchor={ref}
          placement="top-start"
          offset={4}
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label={title}
          className={styles.errorPopup}
        >
          <div className={styles.errorPopupTitle}>{title}</div>
          <div className={styles.errorPopupText}>{error}</div>
        </Popup>
      )}
    </>
  );
}

function ErrorLabel({ text }: { text: string }) {
  return (
    <span className={styles.statusText} title={text}>
      <Icon name="error" size={16} />
      <span className={styles.ellipsis}>{text}</span>
    </span>
  );
}

function LoadingLabel({ text }: { text: string }) {
  return (
    <span className={styles.statusText}>
      <Spinner size={14} />
      <span className={styles.ellipsis}>{text}</span>
    </span>
  );
}

/** The branches check, then the creation progress (`statusPanel`). */
function StatusLine() {
  const check = useCreatePr((s) => s.check);
  const creation = useCreatePr((s) => s.creation);
  let checkLine = null;
  if (check?.state === "loading") checkLine = <LoadingLabel text={tx("Checking pull request branches")} />;
  else if (check?.state === "error")
    checkLine = (
      <>
        <ErrorLabel text={tx("Failed to check pull request branches")} />
        <ErrorDetails title={tx("Failed to check pull request branches")} error={check.error} />
        <IconButton icon="refresh" size="small" title="Refresh" onClick={() => void refreshBranchesState()} />
      </>
    );
  else if (check?.state === "ok" && check.value.kind === "alreadyExists") {
    const n = check.value.number;
    checkLine = (
      <>
        <ErrorLabel text={tx("Pull request already exists")} />
        <button type="button" className={styles.textLink} onClick={() => void openPullRequest(n)}>
          <T>View</T>
        </button>
      </>
    );
  } else if (check?.state === "ok" && check.value.kind === "noChanges")
    checkLine = <ErrorLabel text={tx`No changes between '${check.value.base}' and '${check.value.head}'`} />;

  let progressLine = null;
  if (creation?.kind === "pushing") progressLine = <LoadingLabel text={tx("Pushing a pull request branch")} />;
  else if (creation?.kind === "creating") progressLine = <LoadingLabel text={tx("Creating a pull request")} />;
  else if (creation?.kind === "metadata") progressLine = <LoadingLabel text={tx("Updating pull request fields")} />;
  else if (creation?.kind === "error")
    progressLine = (
      <>
        <ErrorLabel text={tx("Failed to create a pull request")} />
        <ErrorDetails title={tx("Failed to create a pull request")} error={creation.error} />
      </>
    );
  if (!checkLine && !progressLine) return null;
  return (
    <div className={styles.status} role="status">
      {checkLine && <div className={styles.statusRow}>{checkLine}</div>}
      {progressLine && <div className={styles.statusRow}>{progressLine}</div>}
    </div>
  );
}

/** `JBOptionButton`: "Create Pull Request" and, behind the arrow, "Create Draft Pull Request". */
function CreateButton() {
  const enabled = useCreatePr(canCreate);
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const options: MenuItem[] = [
    { label: "Create Draft Pull Request", disabled: !enabled, run: () => void createFromForm(true) },
  ];
  return (
    <div ref={ref} className={styles.optionButton}>
      <Button variant="primary" disabled={!enabled} onClick={() => void createFromForm(false)}>
        <T>Create Pull Request</T>
      </Button>
      <button
        type="button"
        className={styles.optionArrow}
        aria-label={tx("More create options")}
        aria-haspopup="menu"
        disabled={!enabled}
        onClick={() => setMenu(true)}
      >
        <Icon name="chevron-down" size={14} />
      </button>
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={ref}
        items={options}
        placement="top-start"
        aria-label="Create options"
      />
    </div>
  );
}
