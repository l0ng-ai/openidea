/**
 * Settings › PHP › Laravel › Code generation: what the Laravel generators (Laravel ›
 * Generate › Model…) write — the application's namespace, the module new classes go
 * to, the class-name suffixes, constructor promotion and return types. The native PHP
 * engine reads them (`LaravelCodeGeneration`); the templates themselves are the
 * "Laravel …" code templates of Editor › File and Code Templates.
 */
import { useId } from "react";
import { Input } from "@/ui";
import { Row, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import styles from "./Sdk.module.css";

const KEY = "languages.php.laravel.generation";

/** The suffix settings and their defaults (`LaravelCodeGeneration::default`). */
export const SUFFIXES = [
  { key: "controllerSuffix", label: "Controller suffix", fallback: "Controller" },
  { key: "requestSuffix", label: "Form Request suffix", fallback: "Request" },
  { key: "resourceSuffix", label: "JSON resource suffix", fallback: "Resource" },
  { key: "policySuffix", label: "Policy suffix", fallback: "Policy" },
  { key: "seederSuffix", label: "Seeder suffix", fallback: "Seeder" },
] as const;

function TextRow({
  k,
  label,
  hint,
  placeholder,
  fallback,
}: {
  k: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /** The value while the setting is unset. */
  fallback?: string;
}) {
  const [value, set] = useSetting<string>(`${KEY}.${k}`);
  const id = useId();
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        mono
        className={styles.pathInput}
        value={value ?? fallback ?? ""}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value.trim())}
      />
    </Row>
  );
}

export function LaravelCodeGenerationRows() {
  const [promotion, setPromotion] = useSetting<boolean>(`${KEY}.constructorPromotion`);
  const [typeHints, setTypeHints] = useSetting<boolean>(`${KEY}.typeHints`);
  return (
    <>
      <TextRow
        k="namespace"
        label="Application namespace"
        placeholder="From composer.json"
        hint="The root namespace of generated classes (App\Models, App\Http\Controllers…). Empty uses the namespace composer.json maps to app/."
      />
      <TextRow
        k="module"
        label="Default module"
        placeholder="None: the application"
        hint="The module (nwidart/laravel-modules or a modules folder) the generators put new classes in unless their dialog picks another. Empty puts them in the application."
      />
      {SUFFIXES.map((s) => (
        <TextRow key={s.key} k={s.key} label={s.label} fallback={s.fallback} />
      ))}
      <Toggle
        label="Constructor property promotion"
        checked={promotion ?? true}
        onChange={setPromotion}
        hint="Generated constructors declare their properties as promoted parameters (private Mailer $mailer) rather than assigning them in the body."
      />
      <Toggle
        label="Return type declarations"
        checked={typeHints ?? true}
        onChange={setTypeHints}
        hint="Generated methods declare their return types (: bool, : array). Parameter types are always written: Laravel injects by them."
      />
    </>
  );
}
