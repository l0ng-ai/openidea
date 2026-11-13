//! Java launch support: classpath / JDK resolution and the java-debug server (jdtls).
pub(crate) mod cache;

use crate::Host;
use crate::rpc::Dispatcher;

use super::build::load;
use ide_build::compile;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
use ide_lsp::jdtls::{JavaBuildStatus, JavaLaunchInfo};
use ide_run::BuildPolicy;
use std::path::PathBuf;

/// Cancellable with `cancel_request(request)`.
/// Builds the workspace (when `build`), then resolves the runtime (or test)
/// classpath and the JDK of the module at `module` (absolute, or relative to the project root).
/// A module with Kotlin / Groovy / Scala sources is built by its build system, whose class directories come first.
/// Resources a Gradle build filters or renames are processed by Gradle, replacing the language server's plain copies.
pub async fn java_resolve_launch(
    host: &Host,
    window: &str,
    module: PathBuf,
    test: bool,
    policy: BuildPolicy,
    request: RequestId,
) -> IdeResult<JavaLaunchInfo> {
    host.require_trust(window)?;
    let cancel = host.begin_project_request(window, request);
    let result = resolve_launch(host, window, module, test, policy, &cancel).await;
    host.end_request(request);
    result
}

async fn resolve_launch(
    host: &Host,
    window: &str,
    module: PathBuf,
    test: bool,
    policy: BuildPolicy,
    cancel: &CancellationToken,
) -> IdeResult<JavaLaunchInfo> {
    let started = std::time::Instant::now();
    let project = host.project(window)?;
    let module = project.root.join(module);
    let settings = project.settings.effective();
    // A launch builds incrementally unless the configuration asks for Rebuild or NoBuild.
    let build = policy != BuildPolicy::NoBuild;
    let full = policy == BuildPolicy::Rebuild;
    let build_kind = if full { compile::BuildKind::Rebuild } else { compile::BuildKind::Build };
    let (model, external, mut delegated, prefer_maven, is_maven) = {
        let project = project.clone();
        let settings = settings.clone();
        let module = module.clone();
        tokio::task::spawn_blocking(move || {
            project.java_launch_snapshots.lock().initialize();
            let model = load(&project.root, &project.build_cache_dir(), &settings);
            let non_java = build && compile::launch_has_non_java_sources(&project.root, &model, &module, test);
            let is_maven =
                model.maven.as_ref().is_some_and(|m| m.projects.iter().any(|p| project.root.join(&p.dir) == module));
            let prefer_maven = settings.languages.java.maven.delegate_build;
            let delegated = build
                && delegates_to_external_build(
                    is_maven,
                    policy,
                    non_java,
                    cache::has_record(&project.root, &project.build_cache_dir(), &module),
                    prefer_maven,
                );
            let external = non_java || delegated;
            (model, external, delegated, prefer_maven, is_maven)
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
    };
    let mut external_build =
        if delegated { Some(project.lsp.java_external_build(&module, cancel).await?) } else { None };
    let mut info = project.lsp.java_launch(&module, test, build && !delegated, full, delegated, cancel).await?;
    if info.errors.iter().any(|e| processor_recreated_a_file(&e.message)) {
        if build && !delegated && is_maven {
            // JDT runs an annotation processor again over sources it generated in the same build
            // (MapStruct over MapStruct-Plus's mappers) and fails on the file it already wrote;
            // javac doesn't, so Maven builds the module.
            tracing::info!("Annotation processing failed in JDT; building with Maven");
            delegated = true;
            external_build = Some(project.lsp.java_external_build(&module, cancel).await?);
            info = project.lsp.java_launch(&module, test, false, false, true, cancel).await?;
        }
        if delegated {
            // Maven runs the annotation processors itself; JDT's failure to rerun one is no compile error.
            drop_processor_recreate_errors(&mut info);
        }
    }
    let lsp_ms = started.elapsed().as_millis();
    let data_dir = host.local_data_dir.clone();
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || {
        let _external_build = external_build;
        let built = if delegated {
            let policy = delegated_policy(policy, prefer_maven, info.error_count);
            let outputs = project.java_launch_snapshots.lock().build(
                &project.root,
                &model,
                &module,
                cache::BuildOptions { test, policy },
                ide_sdk::apply::maven_local_repository(&project.root, &settings),
                &cancel,
            )?;
            let copies = use_snapshot(&mut info, &outputs.originals, &outputs.snapshot);
            apply_external_build_result(&mut info, outputs.failure, policy == BuildPolicy::Rebuild);
            copies
        } else if external {
            let built = compile::build_for_launch(&project.root, &model, &module, test, build_kind, &cancel)?;
            if let Some(failure) = built.failure {
                if policy != BuildPolicy::MakeAndContinueOnErrors {
                    return Err(IdeError::internal(failure));
                }
                info.build = Some(JavaBuildStatus::Failed);
                info.hints.push(failure);
            }
            built.class_dirs
        } else {
            Vec::new()
        };
        let mut class_paths: Vec<String> = built.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        for p in std::mem::take(&mut info.class_paths) {
            if !class_paths.iter().any(|c| same_entry(c, &p, cfg!(windows))) {
                class_paths.push(p);
            }
        }
        info.class_paths = class_paths;
        apply_library_classpath(&mut info, &project.root, &settings.project_structure.libraries, test);
        if build && !delegated {
            let cache_dir = project.build_cache_dir();
            match compile::process_launch_resources(&project.root, &model, &cache_dir, &info.class_paths, &cancel) {
                Ok(tasks) if !tasks.is_empty() => tracing::info!(?tasks, "Processed launch resources with Gradle"),
                Ok(_) => {}
                Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
                Err(e) => info.hints.push(format!(
                    "Gradle could not process the resources, so they are used as they are in the source folders:\n{}",
                    e.message
                )),
            }
        }
        let compile_ms = started.elapsed().as_millis() - lsp_ms;
        // The module/project JDK, else the JDK jdtls compiles the module against, else one matching its Java version.
        let project_jdk = ide_sdk::apply::module_jdk(&project.root, &module, &settings);
        let from_jdtls = info.java_home.as_deref().map(ide_sdk::java::java_executable).filter(|p| p.is_file());
        let java = project_jdk.map(|j| ide_sdk::java::java_executable(&j.home)).or(from_jdtls).or_else(|| {
            // The build model's level includes what the module inherits from its parent POMs.
            let release = model
                .maven
                .as_ref()
                .and_then(|m| m.projects.iter().find(|p| project.root.join(&p.dir) == module))
                .and_then(|p| p.java_version)
                .or_else(|| ide_sdk::java::project_java_version(&module));
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

/// With Settings › Maven › Delegate IDE build/run actions to Maven, javac's verdict replaces
/// JDT's. Classes JDT wrote for sources with errors look up to date to Maven's incremental
/// compiler, so a launch JDT reports errors for recompiles everything.
fn delegated_policy(policy: BuildPolicy, prefer_maven: bool, jdt_errors: u32) -> BuildPolicy {
    if prefer_maven && jdt_errors > 0 && matches!(policy, BuildPolicy::Automatic | BuildPolicy::Make) {
        BuildPolicy::Rebuild
    } else {
        policy
    }
}

fn apply_external_build_result(info: &mut JavaLaunchInfo, failure: Option<String>, clean: bool) {
    info.build = Some(if let Some(failure) = failure {
        info.hints.push(failure);
        JavaBuildStatus::Failed
    } else if clean {
        // A clean external build recompiled every source; JDT's diagnostics still describe
        // the previous output (and reject sources javac accepts, e.g. a package mismatch).
        info.errors.clear();
        info.error_count = 0;
        JavaBuildStatus::Succeeded
    } else if info.error_count > 0 {
        // Incremental Maven compilation can accept error-stub classes written by JDT.
        JavaBuildStatus::WithErrors
    } else {
        JavaBuildStatus::Succeeded
    });
}

/// A classpath entry as a comparable key. Entries come from JDT LS and from our own
/// build model, which spell one directory differently on Windows (`\\?\` prefix,
/// `/` or `\\`, drive-letter case); compared as text, a module output stayed on the
/// classpath next to its launch snapshot and every resource was found twice.
fn entry_key(path: &str, windows: bool) -> String {
    let path = match path.strip_prefix(r"\\?\UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => path.strip_prefix(r"\\?\").unwrap_or(path).to_owned(),
    };
    let mut key = if windows { path.replace('\\', "/") } else { path };
    while key.len() > 1 && key.ends_with('/') {
        key.pop();
    }
    if windows { key.to_lowercase() } else { key }
}

fn apply_library_classpath(
    info: &mut JavaLaunchInfo,
    root: &std::path::Path,
    libraries: &[ide_core::settings::ProjectLibrary],
    test: bool,
) {
    use ide_core::settings::DependencyScope;
    let entries: Vec<_> = libraries
        .iter()
        .flat_map(|lib| {
            let allowed = match lib.scope {
                DependencyScope::Compile | DependencyScope::Runtime => true,
                DependencyScope::Test | DependencyScope::Provided => test,
            };
            lib.classes.iter().filter_map(move |entry| {
                ide_sdk::apply::setting_path(root, entry).map(|path| (path.to_string_lossy().into_owned(), allowed))
            })
        })
        .collect();
    // JDT may already have returned these archives on either classpath.
    for paths in [&mut info.class_paths, &mut info.module_paths] {
        paths.retain(|path| {
            let matching: Vec<_> = entries.iter().filter(|(entry, _)| same_entry(path, entry, cfg!(windows))).collect();
            matching.is_empty() || matching.iter().any(|(_, allowed)| *allowed)
        });
    }
    for (entry, allowed) in entries {
        if allowed
            && !info.class_paths.iter().chain(&info.module_paths).any(|path| same_entry(path, &entry, cfg!(windows)))
        {
            info.class_paths.push(entry);
        }
    }
}

/// Whether a launch should be built by the project's build system instead of jdtls.
/// A Rebuild has to clean the output; jdtls' full build only recompiles sources, so
/// Maven modules always delegate for it, even when every source is Java.
/// `prefer_maven` is Settings › Maven › Delegate IDE build/run actions to Maven.
fn delegates_to_external_build(
    is_maven: bool,
    policy: BuildPolicy,
    non_java: bool,
    has_record: bool,
    prefer_maven: bool,
) -> bool {
    is_maven && (prefer_maven || policy == BuildPolicy::Rebuild || non_java || has_record)
}

fn same_entry(a: &str, b: &str, windows: bool) -> bool {
    a == b || entry_key(a, windows) == entry_key(b, windows)
}

fn use_snapshot(info: &mut JavaLaunchInfo, built: &[PathBuf], snapshot: &std::path::Path) -> Vec<PathBuf> {
    use_snapshot_on(info, built, snapshot, cfg!(windows))
}

fn use_snapshot_on(
    info: &mut JavaLaunchInfo,
    built: &[PathBuf],
    snapshot: &std::path::Path,
    windows: bool,
) -> Vec<PathBuf> {
    let mut copies = Vec::new();
    for (index, source) in built.iter().enumerate() {
        let dest = snapshot.join(index.to_string());
        let original = source.to_string_lossy();
        info.class_paths.retain(|p| !same_entry(p, &original, windows));
        let mut modular = false;
        for path in &mut info.module_paths {
            if same_entry(path, &original, windows) {
                *path = dest.to_string_lossy().into_owned();
                modular = true;
            }
        }
        if !modular {
            copies.push(dest);
        }
    }
    copies
}

/// Port of java-debug's DAP server inside the jdtls serving `module` (started on demand).
pub async fn java_debug_server(host: &Host, window: &str, module: PathBuf) -> IdeResult<u16> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let module = project.root.join(module);
    project.lsp.java_debug_server(&module).await
}

/// Incremental build of the jdtls workspace serving `module` (e.g. before HotSwap).
pub async fn java_build_workspace(
    host: &Host,
    window: &str,
    module: PathBuf,
    request: Option<RequestId>,
) -> IdeResult<ide_lsp::jdtls::JavaBuildStatus> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let module = project.root.join(module);
    // HotSwap may cancel the compile (the request id is allocated by the caller).
    let cancel = request.map_or_else(CancellationToken::new, |id| host.begin_request(id));
    let result = project.lsp.java_build(&module, false, &cancel).await;
    if let Some(id) = request {
        host.end_request(id);
    }
    result
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("java_resolve_launch", |c| async move {
        java_resolve_launch(&c.host, &c.window, c.arg("module")?, c.arg("test")?, c.arg("policy")?, c.arg("request")?)
            .await
    });
    d.add("java_debug_server", |c| async move { java_debug_server(&c.host, &c.window, c.arg("module")?).await });
    d.add("java_build_workspace", |c| async move {
        java_build_workspace(&c.host, &c.window, c.arg("module")?, c.arg("request")?).await
    });
}

/// An annotation processor's error for writing a file this build already wrote (JDT's
/// `IdeFilerImpl`: "Source file already created", javac's Filer: "Attempt to recreate a file").
fn processor_recreated_a_file(message: &str) -> bool {
    message.contains("FilerException")
        && (message.contains("Source file already created") || message.contains("Attempt to recreate a file"))
}

fn drop_processor_recreate_errors(info: &mut JavaLaunchInfo) {
    let before = info.errors.len();
    info.errors.retain(|e| !processor_recreated_a_file(&e.message));
    info.error_count = info.error_count.saturating_sub((before - info.errors.len()) as u32);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_a_processor_recreating_its_output() {
        assert!(processor_recreated_a_file(
            "Internal error in the mapping processor: java.lang.RuntimeException: \
             javax.annotation.processing.FilerException: Source file already created: /m/target/generated-sources/annotations/a/AMapper__4Impl.java"
        ));
        assert!(processor_recreated_a_file(
            "javax.annotation.processing.FilerException: Attempt to recreate a file for type a.B"
        ));
        assert!(!processor_recreated_a_file("Source file already created"));
        assert!(!processor_recreated_a_file("cannot find symbol"));
    }

    #[test]
    fn a_delegated_launch_ignores_jdt_processor_recreate_errors() {
        let error = |message: &str| ide_lsp::jdtls::JavaCompileError {
            path: "src/main/java/a/A.java".into(),
            line: 1,
            column: 1,
            message: message.into(),
        };
        let mut info = JavaLaunchInfo {
            error_count: 2,
            errors: vec![
                error(
                    "javax.annotation.processing.FilerException: Source file already created: /m/AMapper__1Impl.java",
                ),
                error("cannot find symbol"),
            ],
            ..Default::default()
        };
        drop_processor_recreate_errors(&mut info);
        assert_eq!(info.error_count, 1);
        assert_eq!(info.errors.len(), 1);
        assert_eq!(info.errors[0].message, "cannot find symbol");
    }

    #[test]
    fn delegated_launches_with_jdt_errors_recompile_with_maven() {
        assert_eq!(delegated_policy(BuildPolicy::Make, true, 1), BuildPolicy::Rebuild);
        assert_eq!(delegated_policy(BuildPolicy::Automatic, true, 2), BuildPolicy::Rebuild);
        assert_eq!(delegated_policy(BuildPolicy::Make, true, 0), BuildPolicy::Make);
        assert_eq!(delegated_policy(BuildPolicy::Make, false, 1), BuildPolicy::Make);
        assert_eq!(
            delegated_policy(BuildPolicy::MakeAndContinueOnErrors, true, 1),
            BuildPolicy::MakeAndContinueOnErrors
        );
    }

    #[test]
    fn rebuild_delegates_maven_builds_to_the_build_system() {
        assert!(delegates_to_external_build(true, BuildPolicy::Rebuild, false, false, false));
        assert!(delegates_to_external_build(true, BuildPolicy::Automatic, true, false, false));
        assert!(delegates_to_external_build(true, BuildPolicy::Make, false, true, false));
        assert!(!delegates_to_external_build(true, BuildPolicy::Automatic, false, false, false));
        assert!(!delegates_to_external_build(true, BuildPolicy::Make, false, false, false));
        assert!(!delegates_to_external_build(false, BuildPolicy::Rebuild, false, false, false));
        assert!(delegates_to_external_build(true, BuildPolicy::Automatic, false, false, true));
        assert!(delegates_to_external_build(true, BuildPolicy::Make, false, false, true));
        assert!(!delegates_to_external_build(false, BuildPolicy::Automatic, false, false, true));
    }

    #[test]
    fn successful_external_compilation_does_not_erase_scoped_jdt_errors() {
        for (failure, expected) in
            [(None, JavaBuildStatus::WithErrors), (Some("compile failed"), JavaBuildStatus::Failed)]
        {
            let mut info = JavaLaunchInfo {
                error_count: 1,
                errors: vec![ide_lsp::jdtls::JavaCompileError {
                    path: "src/main/java/Main.java".into(),
                    line: 4,
                    column: 28,
                    message: "missingName cannot be resolved to a variable".into(),
                }],
                ..Default::default()
            };
            let errors = info.errors.clone();
            apply_external_build_result(&mut info, failure.map(str::to_owned), false);
            assert_eq!(info.build, Some(expected));
            assert_eq!(info.error_count, 1);
            assert_eq!(info.errors, errors);
            assert_eq!(info.hints, failure.into_iter().collect::<Vec<_>>());
        }
        let mut info = JavaLaunchInfo::default();
        apply_external_build_result(&mut info, None, false);
        assert_eq!(info.build, Some(JavaBuildStatus::Succeeded));
    }

    #[test]
    fn clean_external_build_clears_stale_jdt_errors() {
        let mut info = JavaLaunchInfo {
            error_count: 7,
            errors: vec![ide_lsp::jdtls::JavaCompileError {
                path: "src/main/java/Main.java".into(),
                line: 0,
                column: 0,
                message: "stale JDT diagnostic".into(),
            }],
            ..Default::default()
        };
        apply_external_build_result(&mut info, None, true);
        assert_eq!(info.build, Some(JavaBuildStatus::Succeeded));
        assert_eq!(info.error_count, 0);
        assert!(info.errors.is_empty());
    }

    #[test]
    fn library_scopes_filter_jdt_classpaths_and_module_paths() {
        use ide_core::settings::{DependencyScope, ProjectLibrary};
        let root = tempfile::tempdir().unwrap();
        let scopes =
            [DependencyScope::Compile, DependencyScope::Runtime, DependencyScope::Test, DependencyScope::Provided];
        let libraries: Vec<_> = scopes
            .iter()
            .enumerate()
            .map(|(i, scope)| ProjectLibrary {
                classes: vec![format!("lib/{i}.jar")],
                scope: *scope,
                ..Default::default()
            })
            .collect();
        let paths: Vec<_> =
            (0..4).map(|i| root.path().join(format!("lib/{i}.jar")).to_string_lossy().into_owned()).collect();
        for test in [false, true] {
            let mut info =
                JavaLaunchInfo { class_paths: paths.clone(), module_paths: paths.clone(), ..Default::default() };
            apply_library_classpath(&mut info, root.path(), &libraries, test);
            let expected = if test { &paths[..] } else { &paths[..2] };
            assert_eq!(info.class_paths, expected);
            assert_eq!(info.module_paths, expected);
        }
        let mut info = JavaLaunchInfo::default();
        apply_library_classpath(&mut info, root.path(), &libraries, false);
        assert_eq!(info.class_paths, &paths[..2]);
    }

    /// JDT LS and our build model spell a module output differently on Windows; the
    /// snapshot must still replace it, or resources (MyBatis mapper XML) load twice.
    #[test]
    fn snapshots_replace_outputs_however_windows_spells_them() {
        let built = PathBuf::from(r"D:\workspace\arm\arm-web\target/classes");
        let jdtls = [
            r"D:\workspace\arm\arm-web\target\classes",
            r"d:\workspace\arm\arm-web\target\classes",
            r"D:/workspace/arm/arm-web/target/classes/",
            r"\\?\D:\workspace\arm\arm-web\target\classes",
        ];
        for spelled in jdtls {
            let mut info = JavaLaunchInfo {
                class_paths: vec![spelled.into(), r"D:\m2\mybatis.jar".into()],
                module_paths: vec![spelled.into()],
                ..Default::default()
            };
            use_snapshot_on(&mut info, std::slice::from_ref(&built), std::path::Path::new(r"C:\cache\launch-x"), true);
            assert_eq!(info.class_paths, [r"D:\m2\mybatis.jar"], "{spelled}");
            assert_eq!(
                info.module_paths,
                [std::path::Path::new(r"C:\cache\launch-x").join("0").to_string_lossy()],
                "{spelled}"
            );
        }
        assert!(same_entry(r"\\?\UNC\server\share\app\target\classes", r"\\server\share\app\target/classes", true));
        // Different directories stay different, and other platforms keep case and `\`.
        assert!(!same_entry(r"D:\a\target\classes", r"D:\a\target\test-classes", true));
        assert!(!same_entry("/work/App/target/classes", "/work/app/target/classes", false));
        assert!(!same_entry(r"/work/a\b", "/work/a/b", false));
        assert!(same_entry("/work/app/target/classes/", "/work/app/target/classes", false));
    }

    #[test]
    fn launch_snapshots_survive_jdt_overwrites_and_replace_module_outputs() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("app/target/classes");
        let lib = root.path().join("lib/target/classes");
        for dir in [&app, &lib] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("Channel.class"), "Maven bytecode").unwrap();
        }
        let mut info = JavaLaunchInfo {
            class_paths: vec![app.to_string_lossy().into_owned(), "stdlib.jar".into()],
            module_paths: vec![lib.to_string_lossy().into_owned()],
            ..Default::default()
        };
        let snapshot = tempfile::tempdir().unwrap();
        for (i, source) in [&app, &lib].iter().enumerate() {
            ide_vfs::copy(source, &snapshot.path().join(i.to_string())).unwrap();
        }
        let paths = use_snapshot(&mut info, &[app.clone(), lib.clone()], snapshot.path());
        assert_eq!(paths, [snapshot.path().join("0")]);
        assert_eq!(info.class_paths, ["stdlib.jar"]);
        assert_eq!(info.module_paths, [snapshot.path().join("1").to_string_lossy().into_owned()]);
        std::fs::write(app.join("Channel.class"), "JDT error stub").unwrap();
        std::fs::remove_dir_all(lib).unwrap();
        for index in ["0", "1"] {
            assert_eq!(
                std::fs::read_to_string(snapshot.path().join(index).join("Channel.class")).unwrap(),
                "Maven bytecode"
            );
        }
    }
}
