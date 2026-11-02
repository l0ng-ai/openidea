import { create } from "zustand";
import { useProject } from "@/platform/project";
import { useRecent } from "@/features/welcome/recent";
import type { EmptyForm, GeneratorId, JavaForm, SpringBootForm, ViteForm } from "./types";

function getDefaultProjectsDir(): string {
  const custom = useProject.getState().settings?.general?.defaultProjectDirectory?.trim();
  if (custom) return custom;
  const home = useRecent.getState().home;
  if (!home) return "C:\\Users";
  return `${home}\\IdeaProjects`;
}

interface NewProjectState {
  isOpen: boolean;
  activeId: GeneratorId;
  searchQuery: string;
  isCreating: boolean;
  createError: string | null;

  springBoot: SpringBootForm;
  java: JavaForm;
  empty: EmptyForm;
  vite: ViteForm;

  openDialog: () => void;
  closeDialog: () => void;
  setActiveId: (id: GeneratorId) => void;
  setSearchQuery: (q: string) => void;
  setIsCreating: (v: boolean) => void;
  setCreateError: (err: string | null) => void;

  updateSpringBoot: (patch: Partial<SpringBootForm>) => void;
  updateJava: (patch: Partial<JavaForm>) => void;
  updateEmpty: (patch: Partial<EmptyForm>) => void;
  updateVite: (patch: Partial<ViteForm>) => void;
}

export const useNewProjectStore = create<NewProjectState>((set) => ({
  isOpen: false,
  activeId: "spring-boot",
  searchQuery: "",
  isCreating: false,
  createError: null,

  springBoot: {
    serverUrl: "start.spring.io",
    name: "demo1",
    location: getDefaultProjectsDir(),
    createGit: false,
    language: "java",
    type: "maven",
    group: "com.example",
    artifact: "demo1",
    packageName: "com.example.demo",
    jdk: "",
    javaVersion: "17",
    packaging: "jar",
    configuration: "properties",
  },

  java: {
    name: "untitled",
    location: getDefaultProjectsDir(),
    createGit: false,
    buildSystem: "maven",
    jdk: "",
    addSampleCode: true,
  },

  empty: {
    name: "untitled",
    location: getDefaultProjectsDir(),
    createGit: false,
  },

  vite: {
    name: "vite-project",
    location: getDefaultProjectsDir(),
    createGit: false,
    framework: "react",
    language: "ts",
  },

  openDialog: () => {
    const loc = getDefaultProjectsDir();
    set((s) => ({
      isOpen: true,
      createError: null,
      isCreating: false,
      springBoot: { ...s.springBoot, location: loc },
      java: { ...s.java, location: loc },
      empty: { ...s.empty, location: loc },
      vite: { ...s.vite, location: loc },
    }));
  },

  closeDialog: () => set({ isOpen: false }),

  setActiveId: (activeId) => set({ activeId, createError: null }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  setIsCreating: (isCreating) => set({ isCreating }),

  setCreateError: (createError) => set({ createError }),

  updateSpringBoot: (patch) =>
    set((s) => {
      const next = { ...s.springBoot, ...patch };
      // When name changes, automatically update artifact and package name if not manually modified
      if (patch.name !== undefined) {
        const cleanName = patch.name.replace(/[^a-zA-Z0-9_-]/g, "");
        next.artifact = cleanName;
        const pkgSuffix = cleanName.toLowerCase().replace(/[^a-z0-9]/g, "");
        next.packageName = `${next.group}.${pkgSuffix || "demo"}`;
      }
      if (patch.group !== undefined) {
        const pkgSuffix = next.artifact.toLowerCase().replace(/[^a-z0-9]/g, "");
        next.packageName = `${patch.group}.${pkgSuffix || "demo"}`;
      }
      return { springBoot: next };
    }),

  updateJava: (patch) => set((s) => ({ java: { ...s.java, ...patch } })),

  updateEmpty: (patch) => set((s) => ({ empty: { ...s.empty, ...patch } })),

  updateVite: (patch) => set((s) => ({ vite: { ...s.vite, ...patch } })),
}));
