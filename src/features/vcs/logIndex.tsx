import { useEffect } from "react";
import { create } from "zustand";
import type { LogIndexProgress } from "@/bindings";
import { call, commands, nextRequestId, type RequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { useVcs } from "./store";
import { IconButton } from "@/ui";

interface Job {
  version?: number;
  restart?: boolean;
  users: number;
  request: RequestId | null;
  paused: boolean;
  progress: LogIndexProgress;
  timer?: ReturnType<typeof setInterval>;
}
const jobs = new Map<string, Job>();
const revision = create<{ value: number }>(() => ({ value: 0 }));
const notify = () => revision.setState((s) => ({ value: s.value + 1 }));
function start(repo: string, job: Job) {
  if (job.paused) return;
  if (job.request != null) {
    job.restart = true;
    return;
  }
  const request = nextRequestId();
  job.request = request;
  job.progress = { ...job.progress, running: true };
  job.timer = setInterval(() => {
    void call(commands.vcsLogIndex(repo, null))
      .then((progress) => {
        if (job.request === request) {
          job.progress = progress;
          notify();
        }
      })
      .catch(() => undefined);
  }, 750);
  void call(commands.vcsLogIndex(repo, request))
    .then(
      (progress) => {
        job.progress = progress;
      },
      () => {
        job.progress = { ...job.progress, running: false };
      },
    )
    .finally(() => {
      if (job.request !== request) return;
      job.request = null;
      clearInterval(job.timer);
      if (job.restart && job.users && !job.paused) {
        job.restart = false;
        start(repo, job);
      }
      notify();
    });
  notify();
}

/** Visible log scopes share one background job per repository. */
export function LogIndexStatus({ repositories }: { repositories: readonly string[] }) {
  revision((s) => s.value);
  const version = useVcs((s) => s.version);
  useEffect(() => {
    for (const repo of repositories) {
      const job: Job = jobs.get(repo) ?? {
        users: 0,
        request: null,
        paused: false,
        progress: { indexed: 0, total: 0, running: false },
      };
      jobs.set(repo, job);
      const first = job.users++ === 0;
      if (first || job.version !== version) {
        job.version = version;
        start(repo, job);
      }
    }
    return () => {
      for (const repo of repositories) {
        const job = jobs.get(repo)!;
        if (--job.users === 0) {
          clearInterval(job.timer);
          if (job.request != null) void commands.cancelRequest(job.request).catch(() => undefined);
        }
      }
    };
  }, [repositories, version]);
  return repositories.map((repo) => {
    const job = jobs.get(repo);
    if (!job || (!job.paused && !job.progress.running)) return null;
    return (
      <div key={repo} role="status" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {tx`Indexing Git log: ${job.progress.indexed} / ${job.progress.total}`}
        <IconButton
          icon={job.paused ? "play" : "pause"}
          title={job.paused ? "Resume Indexing" : "Pause Indexing"}
          onClick={() => {
            job.paused = !job.paused;
            if (job.paused && job.request != null) void commands.cancelRequest(job.request).catch(() => undefined);
            else start(repo, job);
            notify();
          }}
        />
      </div>
    );
  });
}
