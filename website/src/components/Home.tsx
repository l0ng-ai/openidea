import * as stylex from "@stylexjs/stylex";
import { Dialog } from "@base-ui/react/dialog";
import { publicAsset } from "../lib/paths.mjs";
import { styles as s } from "./home.stylex";
import { SiteHeader, SiteFooter, repository, docs } from "./SiteLayout";
import { useDownloadPath } from "./useDownloadPath";

const screenshot = publicAsset("media/debug.jpg", import.meta.env.BASE_URL);
const imageDescription = "A Rust project in OpenIDEA, paused at a breakpoint with variables visible in the debugger.";

function ProductPreview() {
  return (
    <Dialog.Root>
      <Dialog.Trigger {...stylex.props(s.product)} aria-label="Enlarge OpenIDEA debugger screenshot">
        <img
          {...stylex.props(s.productImage)}
          src={screenshot}
          width={3200}
          height={1996}
          alt={imageDescription}
          fetchPriority="high"
        />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(s.backdrop)} />
        <Dialog.Popup {...stylex.props(s.popup)}>
          <div {...stylex.props(s.dialogHeader)}>
            <Dialog.Title {...stylex.props(s.dialogTitle)}>Rust debugging in OpenIDEA</Dialog.Title>
            <Dialog.Close {...stylex.props(s.button)}>Close</Dialog.Close>
          </div>
          <img {...stylex.props(s.dialogImage)} src={screenshot} width={3200} height={1996} alt={imageDescription} />
          <Dialog.Description {...stylex.props(s.dialogDescription)}>
            Breakpoints, variable inspection and your project in one window.
          </Dialog.Description>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Home() {
  const downloads = useDownloadPath();
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section {...stylex.props(s.content, s.hero)} aria-labelledby="headline">
          <ProductPreview />
          <h1 {...stylex.props(s.headline)} id="headline">
            The IDE you know,
            <br />
            rebuilt in Rust.
          </h1>
          <p {...stylex.props(s.description)}>
            An open-source IDE with the keymap, tool windows
            <br {...stylex.props(s.desktopBreak)} /> and Search Everywhere you already know.
          </p>
          <div {...stylex.props(s.actions)}>
            <a {...stylex.props(s.button, s.primary)} href={downloads}>
              Download OpenIDEA
            </a>
            <a {...stylex.props(s.button)} href={docs}>
              Documentation
            </a>
          </div>
          <div {...stylex.props(s.platforms)}>macOS, Windows and Linux</div>
        </section>
        <section {...stylex.props(s.section, s.content, s.workflow)} aria-labelledby="workflow-title">
          <div>
            <h2 {...stylex.props(s.heading)} id="workflow-title">
              Keep your way of working.
            </h2>
            <p {...stylex.props(s.intro)}>
              Move between your code and your tools with the habits you have built in IntelliJ IDEA.
            </p>
          </div>
          <dl {...stylex.props(s.workflowList)}>
            <div>
              <dt {...stylex.props(s.term)}>
                Search Everywhere{" "}
                <span {...stylex.props(s.keys)} aria-label="Press Shift twice">
                  <kbd {...stylex.props(s.key)}>Shift</kbd>
                  <kbd {...stylex.props(s.key)}>Shift</kbd>
                </span>
              </dt>
              <dd {...stylex.props(s.definition)}>Find files, symbols, actions and settings from one place.</dd>
            </div>
            <div>
              <dt {...stylex.props(s.term)}>Edit, run and debug</dt>
              <dd {...stylex.props(s.definition)}>
                Code insight, breakpoints and variable inspection, with support for 60+ languages.
              </dd>
            </div>
            <div>
              <dt {...stylex.props(s.term)}>Your tools in one window</dt>
              <dd {...stylex.props(s.definition)}>
                Git, terminal, database and HTTP clients built into the workbench.
              </dd>
            </div>
          </dl>
        </section>
        <section {...stylex.props(s.section, s.content)} aria-labelledby="performance-title">
          <h2 {...stylex.props(s.heading)} id="performance-title">
            Startup and memory.
          </h2>
          <p {...stylex.props(s.benchmarkIntro)}>Opening freqtrade, a Python project with about 770 files.</p>
          <table {...stylex.props(s.table)} aria-label="Benchmark comparison between OpenIDEA and IntelliJ IDEA">
            <thead>
              <tr>
                <th {...stylex.props(s.cell, s.columnHeading, s.measurement)} scope="col">
                  Measurement
                </th>
                <th {...stylex.props(s.cell, s.columnHeading)} scope="col">
                  OpenIDEA
                </th>
                <th {...stylex.props(s.cell, s.columnHeading)} scope="col">
                  IntelliJ IDEA
                  <br />
                  2026.2.3
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Project window", "0.9 s", "3.1 s"],
                ["Ready, CPU settled", "1.1 s", "13.2 s"],
                ["Memory, USS", "169 MB", "2011 MB"],
              ].map(([name, openidea, idea]) => (
                <tr key={name}>
                  <th {...stylex.props(s.cell, s.measurement)} scope="row">
                    {name}
                  </th>
                  <td {...stylex.props(s.cell, s.result)}>{openidea}</td>
                  <td {...stylex.props(s.cell, s.muted)}>{idea}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p {...stylex.props(s.conditions)}>
            Warm caches, median of 5 runs. Windows 11, 32-core AMD, 62 GB RAM. OpenIDEA release build from main; IDEA
            with default settings and plugins. Memory includes all processes. IDEA analyses Python more deeply, so
            “ready” does not mean the same work on both sides.
          </p>
          <a {...stylex.props(s.textLink)} href={`${repository}/tree/main/perf/compare`}>
            Read the methodology and run it yourself
          </a>
        </section>
        <section {...stylex.props(s.section, s.content, s.getStarted)} id="download" aria-labelledby="download-title">
          <h2 {...stylex.props(s.heading)} id="download-title">
            Try OpenIDEA.
          </h2>
          <p {...stylex.props(s.downloadCopy)}>
            Available for macOS, Windows and Linux.
            <br />
            Open source under Apache 2.0.
          </p>
          <div {...stylex.props(s.actions, s.downloadActions)}>
            <a {...stylex.props(s.button, s.primary, s.downloadButton)} href={downloads}>
              Download OpenIDEA
            </a>
          </div>
          <a {...stylex.props(s.textLink, s.sourceLink)} href={docs}>
            Or build from source
          </a>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
