//! Java launch support: classpath / JDK resolution and the java-debug server (jdtls).
use crate::Host;
use crate::rpc::Dispatcher;

use super::build::load;
use ide_build::compile;
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
use ide_lsp::jdtls::JavaLaunchInfo;
use std::path::PathBuf;

/// Cancellable with `cancel_request(request)`.
/// Builds the workspace (when `build`), then resolves the runtime (or test)
/// classpath and the JDK of the module at `module` (absolute, or relative to the project root).
/// A module with Kotlin / Groovy / Scala sources is built by its build system, whose class directories come first.
pub async fn java_resolve_launch(
    host: &Host,
    window: &str,
    module: PathBuf,
    test: bool,
    build: bool,
    request: RequestId,
) -> IdeResult<JavaLaunchInfo> {
    let cancel = host.begin_request(request);
    let result = resolve_launch(host, window, module, test, build, &cancel).await;
    host.end_request(request);
    result
}

async fn resolve_launch(
    host: &Host,
    window: &str,
    module: PathBuf,
    test: bool,
    build: bool,
    cancel: &CancellationToken,
) -> IdeResult<JavaLaunchInfo> {
    let started = std::time::Instant::now();
    let project = host.project(window)?;
    let module = project.root.join(module);
    let settings = project.settings.effective();
    // Let jdtls finish its build before the external compiler writes Kotlin/Scala classes.
    let mut info = project.lsp.java_launch(&module, test, build, cancel).await?;
    let lsp_ms = started.elapsed().as_millis();
    let data_dir = host.data_dir.clone();
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || {
        let built = if build && compile::has_non_java_sources(&module) {
            compile::build_for_launch(
                &project.root,
                &load(&project.root, &project.build_cache_dir(), &settings),
                &module,
                test,
                &cancel,
            )?
        } else {
            Vec::new()
        };
        let mut class_paths: Vec<String> = built.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        for p in std::mem::take(&mut info.class_paths) {
            if !class_paths.contains(&p) {
                class_paths.push(p);
            }
        }
        info.class_paths = class_paths;
        let compile_ms = started.elapsed().as_millis() - lsp_ms;
        // The project JDK, else the JDK jdtls compiles the module against, else one matching its Java version.
        let project_jdk = ide_sdk::apply::project_jdk(&project.root, &settings);
        let from_jdtls = info.java_home.as_deref().map(ide_sdk::java::java_executable).filter(|p| p.is_file());
        let java = project_jdk.map(|j| ide_sdk::java::java_executable(&j.home)).or(from_jdtls).or_else(|| {
            let release = ide_sdk::java::project_java_version(&module);
            let jdks = ide_sdk::java::installed_jdks();
            info.hints.extend(ide_sdk::java::missing_jdk_message(&jdks, release));
            ide_sdk::java::pick_jdk(&jdks, release).map(|j| ide_sdk::java::java_executable(&j.home))
        });
        info.java_exec = Some(java.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "java".to_owned()));
        let exec = PathBuf::from(info.java_exec.as_deref().unwrap_or("java"));
        let shorten =
            ide_run::java_cmdline::shortening_for(&exec, &info.class_paths, &info.module_paths, cfg!(windows));
        info.shorten_command_line = Some(shorten.as_str().to_owned());
        if info.error_count > 0 {
            let own = ide_sdk::lombok::agent_in_args(settings.languages.java.jdtls_vm_args.split_whitespace());
            let managed = ide_tools::managed_bundle(&data_dir, "lombok");
            let repo = ide_sdk::apply::maven_local_repository(&project.root, &settings);
            let root = project.root.clone();
            // Detection may read the project's sources.
            let lombok = ide_sdk::lombok::lombok_agent(&root, own, managed, repo);
            info.hints.extend(lombok.problem());
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        tracing::info!(
            lsp_ms,
            compile_ms,
            jdk_ms = started.elapsed().as_millis() - lsp_ms - compile_ms,
            total_ms = started.elapsed().as_millis(),
            "Java launch resolved"
        );
        Ok(info)
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Port of java-debug's DAP server inside the jdtls serving `module` (started on demand).
pub async fn java_debug_server(host: &Host, window: &str, module: PathBuf) -> IdeResult<u16> {
    let project = host.project(window)?;
    let module = project.root.join(module);
    project.lsp.java_debug_server(&module).await
}

/// Incremental build of the jdtls workspace serving `module` (e.g. before HotSwap).
pub async fn java_build_workspace(
    host: &Host,
    window: &str,
    module: PathBuf,
) -> IdeResult<ide_lsp::jdtls::JavaBuildStatus> {
    let project = host.project(window)?;
    let module = project.root.join(module);
    project.lsp.java_build(&module, &CancellationToken::new()).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("java_resolve_launch", |c| async move {
        java_resolve_launch(&c.host, &c.window, c.arg("module")?, c.arg("test")?, c.arg("build")?, c.arg("request")?)
            .await
    });
    d.add("java_debug_server", |c| async move { java_debug_server(&c.host, &c.window, c.arg("module")?).await });
    d.add("java_build_workspace", |c| async move { java_build_workspace(&c.host, &c.window, c.arg("module")?).await });
}
