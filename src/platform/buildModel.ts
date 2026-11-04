/**
 * The open project's build model as the Maven / Gradle tool windows last loaded it, for the
 * features that follow the build (run, Project view) without loading it again.
 */
import { create } from "zustand";
import type { BuildModel } from "./ipc";

export interface SharedBuildModel {
  /** Project the model belongs to. */
  root: string | null;
  model: BuildModel | null;
  /** Gradle tool window's "Offline" toggle. */
  gradleOffline: boolean;
}

export const useBuildModel = create<SharedBuildModel>(() => ({ root: null, model: null, gradleOffline: false }));
