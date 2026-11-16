/** The project's Cucumber steps and step definitions, scanned once and kept until a source changes. */
import { call, commands, type Location } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import {
  ENGLISH,
  featureSteps,
  gherkinLanguage,
  matchesStep,
  stepDefinitions,
  type FeatureStep,
  type GherkinDialect,
  type StepDefinition,
} from "./steps";

interface Indexed<T> {
  path: string;
  text: string;
  items: T[];
}

interface StepIndex {
  definitions: Indexed<StepDefinition>[];
  steps: Indexed<FeatureStep>[];
}

let cached: Promise<StepIndex> | null = null;

/** The keywords of a feature file's `# language:` (English when it names none or an unknown one). */
export async function dialectOf(text: string): Promise<GherkinDialect> {
  const code = gherkinLanguage(text);
  if (!code || code === "en") return ENGLISH;
  const { GHERKIN_DIALECTS } = await import("./gherkinDialects");
  return GHERKIN_DIALECTS[code] ?? ENGLISH;
}

/** Whether a change to `path` can change the index: a feature or script file. */
export function isCucumberSource(path: string): boolean {
  return /\.(feature|[cm]?[jt]sx?|java|kt)$/i.test(path);
}

/** Forgets the index, so the next lookup rescans the project. */
export function clearStepIndex() {
  cached = null;
}

function stepIndex(): Promise<StepIndex> {
  cached ??= call(commands.cucumberSources()).then(
    async (sources) => {
      const index: StepIndex = { definitions: [], steps: [] };
      for (const s of sources) {
        const path = ipcPath(s.path);
        if (s.feature) index.steps.push({ path, text: s.text, items: featureSteps(s.text, await dialectOf(s.text)) });
        else {
          const items = stepDefinitions(s.text);
          if (items.length) index.definitions.push({ path, text: s.text, items });
        }
      }
      return index;
    },
    (e: unknown) => {
      cached = null;
      throw e;
    },
  );
  return cached;
}

/** The 0-based line and UTF-16 column of `offset` in `text`. */
function position(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, col: offset - start };
}

const location = (path: string, text: string, from: number, to: number, name: string) => ({
  path,
  range: { start: position(text, from), end: position(text, to) },
  name,
});

/** The definitions matching a feature step. */
export async function definitionsOf(step: FeatureStep): Promise<Array<Location & { name: string }>> {
  const { definitions } = await stepIndex();
  return definitions.flatMap((file) =>
    file.items.filter((d) => matchesStep(d, step)).map((d) => location(file.path, file.text, d.from, d.to, d.source)),
  );
}

/** The feature steps a definition matches. */
export async function usagesOf(definition: StepDefinition): Promise<Array<Location & { name: string }>> {
  const { steps } = await stepIndex();
  return steps.flatMap((file) =>
    file.items
      .filter((s) => matchesStep(definition, s))
      .map((s) => location(file.path, file.text, s.from, s.to, `${s.keyword} ${s.text}`)),
  );
}

/** The steps no definition matches; null when the project defines no steps in its scripts. */
export async function undefinedSteps(steps: readonly FeatureStep[]): Promise<FeatureStep[] | null> {
  const { definitions } = await stepIndex();
  if (!definitions.length) return null;
  return steps.filter((step) => !definitions.some((file) => file.items.some((d) => matchesStep(d, step))));
}

/** The file a new definition for a step of `featurePath` goes to: the step file named like the feature, else the one with the most definitions. */
export async function definitionFileFor(featurePath: string): Promise<string | null> {
  const { definitions } = await stepIndex();
  // `cart.steps.ts`, `CartSteps.java` and `cart_stepdefs.kt` all name the `cart` feature's steps.
  const stem = (path: string) =>
    (path.split("/").pop() ?? "")
      .split(".")[0]!
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .replace(/(?:stepdefinitions|stepdefs|steps)$/, "");
  const feature = stem(featurePath);
  const named = definitions.find((file) => stem(file.path) === feature);
  if (named) return named.path;
  const most = [...definitions].sort((a, b) => b.items.length - a.items.length)[0];
  return most?.path ?? null;
}
