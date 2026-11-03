export type GeneratorId = "java" | "kotlin" | "empty" | "spring-boot" | "vite";

export interface GeneratorDef {
  id: GeneratorId;
  name: string;
  category: "New Project" | "Generators";
  icon: string;
  description?: string;
}

export const GENERATOR_ITEMS: GeneratorDef[] = [
  { id: "java", name: "Java", category: "New Project", icon: "file-java" },
  { id: "kotlin", name: "Kotlin", category: "New Project", icon: "file-kotlin" },
  { id: "empty", name: "Empty Project", category: "New Project", icon: "folder" },
  { id: "spring-boot", name: "Spring Boot", category: "Generators", icon: "spring-config" },
  { id: "vite", name: "Vite", category: "Generators", icon: "file-js" },
];

export interface SpringBootForm {
  serverUrl: string;
  name: string;
  location: string;
  createGit: boolean;
  language: "java" | "kotlin" | "groovy";
  type: "gradle-groovy" | "gradle-kotlin" | "maven";
  group: string;
  artifact: string;
  packageName: string;
  jdk: string;
  javaVersion: string;
  packaging: "jar" | "war";
  configuration: "properties" | "yaml";
}

export interface JavaForm {
  name: string;
  location: string;
  createGit: boolean;
  buildSystem: "maven" | "gradle";
  jdk: string;
  addSampleCode: boolean;
}

export interface EmptyForm {
  name: string;
  location: string;
  createGit: boolean;
}

export interface ViteForm {
  name: string;
  location: string;
  createGit: boolean;
  framework: "react" | "vue" | "vanilla";
  language: "ts" | "js";
}
