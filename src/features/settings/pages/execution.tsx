/**
 * Build, Execution, Deployment pages: Maven, Console, Debugger (+ Data Views,
 * Stepping), Python Debugger and Run/Debug. Consumed by the run and debugger
 * features (and `ide-run` for encoding / termination timeout).
 */
import { WORKFLOW_LIMITS } from "@/platform/workflowSettings";
import type { SelectOption } from "@/ui";
import { GlobListEditor, NumberInput, Row } from "../components/Form";
import { MavenPage } from "../languages/LanguagePages";
import { useSetting } from "../components/context";
import type { PageSpec } from "./spec";
import { Indented, ToggleNumber } from "./workflowControls";
import styles from "./Workflow.module.css";
import { T } from "@/ui";

export const BUILD_GROUP = "Build, Execution, Deployment";

const L = WORKFLOW_LIMITS;

export const CONSOLE_ENCODINGS: SelectOption[] = [
  "UTF-8",
  "UTF-16LE",
  "UTF-16BE",
  "ISO-8859-1",
  "windows-1250",
  "windows-1251",
  "windows-1252",
  "GBK",
  "GB18030",
  "Big5",
  "Shift_JIS",
  "EUC-JP",
  "EUC-KR",
  "KOI8-R",
].map((e) => ({ value: e, label: e }));

function BufferRow() {
  return (
    <ToggleNumber
      toggleKey="console.overrideBuffer"
      numberKey="console.bufferKb"
      label="Override console cycle buffer size"
      unit="KB"
      hint="Older output is discarded"
      {...L.bufferKb}
    />
  );
}

function FoldPatterns() {
  const [patterns, set] = useSetting<string[]>("console.foldPatterns");
  return (
    <Row
      label="Fold console lines that contain"
      stacked
      hint="Runs of consecutive matching lines collapse into one expandable “<N internal lines>” row."
    >
      <GlobListEditor
        value={patterns}
        onChange={set}
        placeholder="at org.example."
        aria-label="Fold console lines that contain"
      />
    </Row>
  );
}

function TooltipDelayRow() {
  const [enabled] = useSetting<boolean>("debugger.valueTooltip");
  const [delay, setDelay] = useSetting<number>("debugger.valueTooltipDelay");
  return (
    <Indented>
      <Row label="Value tooltip delay (ms)">
        <NumberInput
          value={delay}
          onChange={setDelay}
          {...L.tooltipDelay}
          integer
          step={100}
          aria-label="Value tooltip delay (ms)"
        />
        {!enabled && (
          <span className={styles.note}>
            <T>Value tooltips are off</T>
          </span>
        )}
      </Row>
    </Indented>
  );
}

export const EXECUTION_PAGES: PageSpec[] = [
  {
    id: "build.maven",
    projectScope: true,
    defaultScope: "project",
    title: "Maven",
    group: BUILD_GROUP,
    // IntelliJ IDEA: Build Tools › Maven, before Console / Debugger.
    order: 359,
    keywords: ["maven home", "mvn", "mvnw", "wrapper", "settings.xml", "user settings", "local repository", "m2"],
    component: MavenPage,
  },
  {
    id: "build.console",
    title: "Console",
    group: BUILD_GROUP,
    order: 360,
    projectScope: true,
    keywords: ["run output", "encoding", "fold", "buffer"],
    sections: [
      {
        options: [
          { kind: "custom", label: "Override console cycle buffer size", keywords: ["KB"], component: BufferRow },
          { kind: "toggle", key: "console.softWrap", label: "Use soft wraps in console" },
          {
            kind: "select",
            key: "console.encoding",
            label: "Default encoding",
            options: CONSOLE_ENCODINGS,
            hint: "Encoding of the output of processes started from Run configurations.",
          },
        ],
      },
      { options: [{ kind: "custom", label: "Fold console lines that contain", component: FoldPatterns }] },
    ],
  },
  {
    id: "build.debugger",
    title: "Debugger",
    group: BUILD_GROUP,
    order: 361,
    projectScope: true,
    keywords: ["debug", "breakpoint"],
    sections: [
      {
        options: [
          { kind: "toggle", key: "debugger.showOnBreakpoint", label: "Show debug window on breakpoint hit" },
          { kind: "toggle", key: "debugger.focusAppOnBreakpoint", label: "Focus application on breakpoint" },
          { kind: "toggle", key: "debugger.hideOnTermination", label: "Hide debug window on process termination" },
        ],
      },
      {
        title: "Breakpoints",
        options: [
          {
            kind: "toggle",
            key: "debugger.breakpointsAnyFile",
            label: "Allow placing breakpoints in any file",
            hint: "Otherwise line breakpoints can only be set in files of languages that have a debugger.",
          },
          {
            kind: "toggle",
            key: "debugger.runToCursorInlay",
            label: "Show inlay Run to Cursor popup",
          },
        ],
      },
    ],
  },
  {
    id: "build.debugger.dataViews",
    title: "Data Views",
    order: 0,
    projectScope: true,
    keywords: ["variables", "inline", "tooltip"],
    sections: [
      {
        options: [
          {
            kind: "toggle",
            key: "debugger.inlineValues",
            label: "Show values inline",
            hint: "Values of local variables are shown after the lines that use them while suspended.",
          },
          { kind: "toggle", key: "debugger.sortValues", label: "Sort values alphabetically" },
          {
            kind: "toggle",
            key: "debugger.valueTooltip",
            label: "Show value tooltip on mouse hover",
            hint: "Hovering a variable while suspended evaluates it in the selected frame.",
          },
          { kind: "toggle", key: "debugger.valueTooltipOnSelection", label: "Show value tooltip on code selection" },
          { kind: "custom", label: "Value tooltip delay (ms)", component: TooltipDelayRow },
        ],
      },
    ],
  },
  {
    id: "build.debugger.stepping",
    title: "Stepping",
    order: 1,
    projectScope: true,
    keywords: ["step into", "library", "just my code"],
    sections: [
      {
        options: [
          {
            kind: "toggle",
            key: "debugger.skipLibraryCode",
            label: "Do not step into library scripts",
            hint: "Python: only your code (justMyCode). JavaScript: skips node_modules and Node.js internals.",
          },
        ],
      },
    ],
  },
  {
    id: "build.pythonDebugger",
    title: "Python Debugger",
    group: BUILD_GROUP,
    order: 362,
    projectScope: true,
    keywords: ["debugpy", "python", "gevent", "subprocess"],
    sections: [
      {
        options: [
          {
            kind: "toggle",
            key: "debugger.python.attachSubprocess",
            label: "Attach to subprocess automatically while debugging",
          },
          {
            kind: "toggle",
            key: "debugger.python.gevent",
            label: "Gevent compatible",
            hint: "Enable when debugging code that uses gevent monkey-patching.",
          },
        ],
      },
    ],
  },
  {
    id: "build.run",
    title: "Run/Debug",
    group: BUILD_GROUP,
    order: 363,
    projectScope: true,
    keywords: ["run configuration", "rerun", "stop", "terminate"],
    sections: [
      {
        options: [
          { kind: "toggle", key: "run.confirmRerun", label: "Confirm rerun with process termination" },
          { kind: "toggle", key: "run.confirmTerminate", label: "Confirm closing a tab with a running process" },
          {
            kind: "toggle",
            key: "run.showOnStart",
            label: "Show Run/Debug window when a process is started",
          },
          {
            kind: "number",
            key: "run.terminationTimeoutMs",
            label: "Time limit for Run/Debug process termination",
            ...L.terminationTimeoutMs,
            integer: true,
            step: 500,
            unit: "ms",
            hint: "After Stop, the process gets this long to exit after the interrupt before it is killed.",
          },
        ],
      },
    ],
  },
];
