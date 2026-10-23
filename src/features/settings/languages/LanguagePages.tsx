/**
 * Settings › Languages & Frameworks › Go / Java / Node.js / Rust / TypeScript: the
 * toolchain each language's server and run configurations use (applied by
 * `ide-sdk` when language servers start and when run configurations load).
 */
import { useId, useMemo } from "react";
import { IconButton, Input, type SelectOption } from "@/ui";
import { Row, Section, Select, Toggle } from "../components/Form";
import { choosePath } from "./api";
import { SdkField, tildify, useDetected, useProjectSetting } from "./components";
import styles from "./Sdk.module.css";

function PathInput({
  k,
  label,
  placeholder,
  hint,
  title,
}: {
  k: string;
  label: string;
  placeholder: string;
  hint?: string;
  title: string;
}) {
  const [value, set] = useProjectSetting<string>(k);
  const id = useId();
  return (
    <Row label={label} htmlFor={id} hint={hint}>
      <span className={styles.pathRow}>
        <Input
          id={id}
          mono
          className={styles.pathInput}
          value={value}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value.trim())}
        />
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          onClick={async () => {
            const p = await choosePath({ directory: true, title, defaultPath: value || undefined });
            if (p) set(p);
          }}
        />
      </span>
    </Row>
  );
}

function SdkRow({
  k,
  label,
  hint,
  ...field
}: { k: string; label: string; hint?: string } & Omit<Parameters<typeof SdkField>[0], "value" | "onChange">) {
  const [value, set] = useProjectSetting<string>(k);
  return (
    <Row label={label} hint={hint}>
      <SdkField {...field} value={value} onChange={set} />
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Node.js

export function NodePage() {
  const [pm, setPm] = useProjectSetting<string>("languages.node.packageManager");
  const { list } = useDetected("packageManager");
  const pmOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "Auto", detail: "from packageManager / lock file" },
      ...(["npm", "pnpm", "yarn", "bun"] as const).map((name) => {
        const found = list.find((s) => s.name === name);
        return {
          value: name,
          label: name,
          detail: found ? `${found.version ?? ""} ${tildify(found.path)}`.trim() : "not found",
        };
      }),
    ],
    [list],
  );
  return (
    <div className={styles.page}>
      <Section>
        <SdkRow
          k="languages.node.interpreter"
          label="Node interpreter"
          kind="node"
          emptyLabel="Default"
          emptyDetail="node on PATH"
          browseTitle="Select Node.js Interpreter"
          aria-label="Node interpreter"
          hint="Runs npm scripts and Node-based language servers (vtsls, eslint, pyright…)."
        />
        <Row label="Package manager" hint="Used by the npm run configurations detected from package.json scripts.">
          <Select value={pm} options={pmOptions} onChange={setPm} aria-label="Package manager" />
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rust

export function RustPage() {
  const [toolchain] = useProjectSetting<string>("languages.rust.toolchain");
  const [checkOnSave, setCheckOnSave] = useProjectSetting<boolean>("languages.rust.checkOnSave");
  const [checkCommand, setCheckCommand] = useProjectSetting<string>("languages.rust.checkCommand");
  const [rustfmtArgs, setRustfmtArgs] = useProjectSetting<string>("languages.rust.rustfmtArgs");
  const { list } = useDetected("rust");
  const selected = list.find((s) => s.path === toolchain);
  const argsId = useId();
  return (
    <div className={styles.page}>
      <Section title="Toolchain">
        <SdkRow
          k="languages.rust.toolchain"
          label="Toolchain location"
          kind="rust"
          emptyLabel="Default"
          emptyDetail="rustup default / PATH"
          directory
          browseTitle="Select Toolchain bin Directory"
          aria-label="Toolchain location"
          hint="cargo run configurations and rust-analyzer use this toolchain (PATH, RUSTUP_TOOLCHAIN)."
        />
        <PathInput
          k="languages.rust.stdlib"
          label="Standard library"
          placeholder={selected?.extra ? tildify(selected.extra) : "Detected from the toolchain"}
          title="Select Standard Library Sources"
          hint="Sources of std for navigation and completion (RUST_SRC_PATH)."
        />
      </Section>
      <Section title="External Linters">
        <Row label="External tool">
          <Select
            value={checkCommand}
            options={[
              { value: "check", label: "Cargo Check" },
              { value: "clippy", label: "Clippy" },
            ]}
            onChange={setCheckCommand}
            aria-label="External tool"
          />
        </Row>
        <Toggle
          label="Run external linter on save"
          checked={checkOnSave}
          onChange={setCheckOnSave}
          hint="rust-analyzer runs the tool after each save and reports its diagnostics."
        />
      </Section>
      <Section title="Rustfmt">
        <Row
          label="Additional arguments"
          htmlFor={argsId}
          hint="Passed to rustfmt when reformatting, e.g. --edition 2024"
        >
          <Input
            id={argsId}
            mono
            className={styles.pathInput}
            value={rustfmtArgs}
            onChange={(e) => setRustfmtArgs(e.target.value)}
          />
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Go

export function GoPage() {
  const { list } = useDetected("go");
  const defaultGopath = list.find((s) => s.extra)?.extra;
  return (
    <div className={styles.page}>
      <Section title="GOROOT">
        <SdkRow
          k="languages.go.goroot"
          label="GOROOT"
          kind="go"
          emptyLabel="Default"
          emptyDetail="go on PATH"
          directory
          browseTitle="Select GOROOT"
          aria-label="GOROOT"
          hint="Go SDK used by gopls and the go run / test configurations."
        />
      </Section>
      <Section title="GOPATH">
        <PathInput
          k="languages.go.gopath"
          label="Project GOPATH"
          placeholder={defaultGopath ? tildify(defaultGopath) : "go env GOPATH"}
          title="Select GOPATH"
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Java

export function JavaPage() {
  const [vmArgs, setVmArgs] = useProjectSetting<string>("languages.java.jdtlsVmArgs");
  const id = useId();
  return (
    <div className={styles.page}>
      <Section title="Language Server">
        <Row
          label="JVM options"
          htmlFor={id}
          hint="Passed to the JVM running jdtls (java.jdt.ls.vmargs), e.g. -Xmx2g. A Lombok agent is added automatically when the project uses Lombok."
        >
          <Input
            id={id}
            mono
            className={styles.pathInput}
            value={vmArgs}
            placeholder="-Xmx2g"
            onChange={(e) => setVmArgs(e.target.value)}
          />
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TypeScript

export function TypeScriptPage() {
  const [version, setVersion] = useProjectSetting<string>("languages.typescript.version");
  const { list } = useDetected("typeScript");
  const workspace = list.find((s) => s.source === "workspace");
  const options = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = [
      { value: "bundled", label: "Bundled", detail: "the language server's own TypeScript" },
      {
        value: "workspace",
        label: workspace ? workspace.name : "node_modules/typescript",
        detail: workspace ? tildify(workspace.path) : "not installed in this project",
      },
    ];
    if (version && version !== "bundled" && version !== "workspace")
      out.push({ value: version, label: tildify(version), detail: "custom" });
    return out;
  }, [workspace, version]);
  return (
    <div className={styles.page}>
      <Section>
        <Row
          label="TypeScript"
          hint="Version used by vtsls / typescript-language-server (typescript.tsdk, tsserver.path)."
        >
          <span className={styles.pathRow}>
            <Select value={version} options={options} onChange={setVersion} aria-label="TypeScript version" />
            <IconButton
              icon="folder-open"
              size="small"
              title="Browse…"
              onClick={async () => {
                const p = await choosePath({ directory: true, title: "Select TypeScript lib Directory" });
                if (p) setVersion(p);
              }}
            />
          </span>
        </Row>
      </Section>
    </div>
  );
}
