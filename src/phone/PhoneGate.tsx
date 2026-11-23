/**
 * The phone's first screens: pairing with a desktop, connecting to it and choosing one of
 * its projects. The workbench takes over once a project is open.
 */
import { useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { call, commands, type ProjectInfo, type RecentProject } from "@/platform/ipc";
import { tx, useTx } from "@/platform/i18n";
import { Button, Icon, Input, T } from "@/ui";
import { Spinner } from "@/ui/Spinner";
import { phoneConnect, phoneForget, phonePair, phoneStatus, routeToDesktop, type PhoneSession } from "./route";
import styles from "./PhoneGate.module.css";

const REOPEN_KEY = "openidea.phone.project";

type Screen =
  | { kind: "loading" }
  | { kind: "pair"; error?: string }
  | { kind: "connecting"; desktop: string }
  | { kind: "offline"; desktop: string; error: string }
  | { kind: "projects"; session: PhoneSession };

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function PhoneGate({ onOpened }: { onOpened: (project: ProjectInfo) => void }) {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  const connect = (desktop: string) => {
    setScreen({ kind: "connecting", desktop });
    phoneConnect()
      .then((session) => {
        routeToDesktop(session);
        setScreen({ kind: "projects", session });
      })
      .catch((e: unknown) => setScreen({ kind: "offline", desktop, error: message(e) }));
  };

  useEffect(() => {
    let live = true;
    void phoneStatus().then((s) => {
      if (!live) return;
      if (s.desktop) connect(s.desktop);
      else setScreen({ kind: "pair" });
    });
    const off = listen("phone://disconnected", () => {
      void phoneStatus().then((s) => s.desktop && live && connect(s.desktop));
    });
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, []);

  const forget = () => void phoneForget().then(() => setScreen({ kind: "pair" }));

  return (
    <div className={styles.gate}>
      {screen.kind === "loading" && <Waiting />}
      {screen.kind === "pair" && (
        <PairScreen
          error={screen.error}
          onPaired={(session) => {
            routeToDesktop(session);
            setScreen({ kind: "projects", session });
          }}
        />
      )}
      {screen.kind === "connecting" && <Waiting>{tx`Connecting to ${screen.desktop}…`}</Waiting>}
      {screen.kind === "offline" && (
        <div className={styles.center}>
          <Icon name="remote" size={32} />
          <h1 className={styles.title}>{tx`Can't reach ${screen.desktop}`}</h1>
          <p className={styles.hint}>
            <T>Make sure OpenIDEA is running on the computer and it is online.</T>
          </p>
          <p className={styles.detail}>{screen.error}</p>
          <Button variant="primary" onClick={() => connect(screen.desktop)}>
            <T>Try Again</T>
          </Button>
          <Button variant="ghost" onClick={forget}>
            <T>Pair with Another Computer</T>
          </Button>
        </div>
      )}
      {screen.kind === "projects" && <ProjectsScreen session={screen.session} onOpened={onOpened} onForget={forget} />}
    </div>
  );
}

function PairScreen({ error, onPaired }: { error?: string; onPaired: (s: PhoneSession) => void }) {
  const t = useTx();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(error);
  const pair = () => {
    setBusy(true);
    setFailed(undefined);
    phonePair(code)
      .then(onPaired)
      .catch((e: unknown) => setFailed(message(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.center}>
      <Icon name="mobile" size={32} />
      <h1 className={styles.title}>
        <T>Pair with Your Computer</T>
      </h1>
      <p className={styles.hint}>
        <T>
          On the computer, open OpenIDEA and run Pair Mobile Device… Then scan its QR code, or paste its pairing code
          here.
        </T>
      </p>
      <Input
        className={styles.code}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="openidea-pair:…"
        aria-label={t("Pairing code")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {failed && (
        <p className={styles.error} role="alert">
          {failed}
        </p>
      )}
      <Button variant="primary" disabled={busy || !code.trim()} onClick={pair}>
        {busy ? <T>Pairing…</T> : <T>Pair</T>}
      </Button>
    </div>
  );
}

function ProjectsScreen({
  session,
  onOpened,
  onForget,
}: {
  session: PhoneSession;
  onOpened: (project: ProjectInfo) => void;
  onForget: () => void;
}) {
  const t = useTx();
  const [projects, setProjects] = useState<RecentProject[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // Back into the project after a reload of the page: no list to show meanwhile.
  const [reopening, setReopening] = useState(() => sessionStorage.getItem(REOPEN_KEY) !== null);
  const [error, setError] = useState<string | null>(null);
  const open = (path: string) => {
    sessionStorage.setItem(REOPEN_KEY, path);
    setOpening(path);
    setError(null);
    call(commands.openProject(path))
      .then(onOpened)
      .catch((e: unknown) => {
        sessionStorage.removeItem(REOPEN_KEY);
        setError(message(e));
        setReopening(false);
      })
      .finally(() => setOpening(null));
  };
  useEffect(() => {
    let live = true;
    commands
      .recentProjects()
      .then((p) => {
        if (!live) return;
        setProjects(p);
        // A reload of the page (not a new start of the app) goes back into its project.
        const again = sessionStorage.getItem(REOPEN_KEY);
        if (again && p.some((x) => x.path === again)) open(again);
        else setReopening(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(message(e));
        setReopening(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (reopening) {
    const name = projects?.find((p) => p.path === opening)?.name;
    return <Waiting>{name ? tx`Opening ${name}…` : tx`Opening the project…`}</Waiting>;
  }
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div className={styles.barText}>
          <span className={styles.barTitle}>
            <T>Projects</T>
          </span>
          <span className={styles.barSub}>{tx`On ${session.desktop}`}</span>
        </div>
        <Button variant="ghost" size="small" onClick={onForget}>
          <T>Unpair</T>
        </Button>
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {projects === null && !error && <Waiting />}
      {projects?.length === 0 && (
        <p className={styles.hint}>
          <T>No recent projects on this computer. Open a project there first.</T>
        </p>
      )}
      <ul className={styles.list} aria-label={t("Projects")}>
        {projects?.map((p) => (
          <li key={p.path}>
            <button
              type="button"
              className={styles.project}
              disabled={p.missing || opening !== null}
              onClick={() => open(p.path)}
            >
              <Icon name="folder" size={20} />
              <span className={styles.projectText}>
                <span className={styles.projectName}>{p.name}</span>
                <span className={styles.projectPath}>{p.path}</span>
              </span>
              {opening === p.path ? <Spinner /> : p.branch ? <span className={styles.branch}>{p.branch}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A wait in the middle of the screen, with what it waits for. */
function Waiting({ children }: { children?: ReactNode }) {
  return (
    <div className={styles.center} role="status">
      <Spinner size={24} />
      {children && <p className={styles.hint}>{children}</p>}
    </div>
  );
}
