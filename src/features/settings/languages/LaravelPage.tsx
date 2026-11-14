/**
 * Settings › Languages & Frameworks › PHP › Laravel: everything Laravel support
 * reads (`LaravelSettings`, passed to the native PHP engine as one struct) —
 * whether the project is a Laravel project, which modules are read, the route
 * hints, the database whose schema is used, the Inertia page folders and what
 * the generators write. The Laravel inspections are in PHP › Inspections.
 */
import type { SelectOption } from "@/ui";
import { GlobListEditor, Row, Section, Select, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import { LaravelCodeGenerationRows } from "./LaravelCodeGeneration";
import { LaravelDatabaseRow } from "./LaravelDatabase";
import styles from "./Sdk.module.css";

const KEY = "languages.php.laravel";

/** `LaravelDetection`. */
export const DETECTION_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto", detail: "laravel/framework or artisan" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

/** `LaravelModuleSystem`. */
export const MODULE_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto", detail: "nwidart modules and module folders" },
  { value: "nwidart", label: "nwidart/laravel-modules" },
  { value: "directory", label: "Module folders" },
  { value: "none", label: "None" },
];

export function LaravelPage() {
  const [detection, setDetection] = useSetting<string>(`${KEY}.detection`);
  const [modules, setModules] = useSetting<string>(`${KEY}.modules`);
  const [routeHints, setRouteHints] = useSetting<boolean>(`${KEY}.routeHints`);
  const [pages, setPages] = useSetting<string[]>(`${KEY}.inertiaPages`);
  const off = detection === "disabled";
  return (
    <div className={styles.page}>
      <Section>
        <Row
          label="Laravel support"
          hint="Auto turns Laravel support on when composer.json requires laravel/framework, composer.lock lists it, or the project has an artisan file. Enabled turns it on for any project, Disabled turns it off."
        >
          <Select
            value={detection || "auto"}
            options={DETECTION_OPTIONS}
            onChange={setDetection}
            aria-label="Laravel support"
          />
        </Row>
        <Row
          label="Modules"
          hint="Which modules of a modular application are read for routes, views, namespaces and generators: nwidart/laravel-modules modules, the folders of modules/, app-modules/, app/Modules/ and src/Modules/, both, or none."
        >
          <Select
            value={modules || "auto"}
            options={MODULE_OPTIONS}
            disabled={off}
            onChange={setModules}
            aria-label="Laravel modules"
          />
        </Row>
      </Section>
      <Section title="Hints">
        <Toggle
          label="Show route hints"
          checked={routeHints ?? true}
          disabled={off}
          onChange={setRouteHints}
          hint="In Laravel projects, shows the routes pointing to each controller method above it and the full URI after each route registration. Click one to go to the route, copy or open its URL, or create an HTTP request for it."
        />
      </Section>
      <Section title="Database">
        <LaravelDatabaseRow />
      </Section>
      <Section title="Inertia">
        <Row
          label="Page folders"
          stacked
          hint="The folders of Inertia pages, relative to the project: page names in Inertia::render() and inertia() are completed from their Vue, React and Svelte files, and new pages are created in the first one. Empty uses the inertia.pagePaths of ide.json, else resources/js/Pages."
        >
          <GlobListEditor
            value={pages ?? []}
            onChange={setPages}
            placeholder="resources/js/Pages"
            emptyText="Default page folders"
            itemLabel="Page folder"
            aria-label="Inertia page folders"
          />
        </Row>
      </Section>
      <Section title="Code Generation">
        <LaravelCodeGenerationRows />
      </Section>
    </div>
  );
}
