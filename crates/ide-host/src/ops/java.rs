//! Java launch support: classpath / JDK resolution and the java-debug server (jdtls).
pub(crate) mod cache;

use crate::Host;
use crate::rpc::Dispatcher;

use super::build::load;
use ide_build::compile;
use ide_core::{CancellationToken, IdeError, IdeResult, RequestId};
use ide_lsp::jdtls::{JavaBuildStatus, JavaLaunchInfo};
use ide_run::BuildPolicy;
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
    let (model, external, delegated) = {
        let project = project.clone();
        let settings = settings.clone();
        let module = module.clone();
        tokio::task::spawn_blocking(move || {
            project.java_launch_snapshots.lock().initialize();
            let model = load(&project.root, &project.build_cache_dir(), &settings);
            let non_java = build && compile::launch_has_non_java_sources(&project.root, &model, &module, test);
            let delegated = build
                && model.maven.as_ref().is_some_and(|m| m.projects.iter().any(|p| project.root.join(&p.dir) == module))
                && (non_java || cache::has_record(&project.root, &project.build_cache_dir(), &module));
            let external = non_java || delegated;
            (model, external, delegated)
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
    };
    let external_build = if delegated { Some(project.lsp.java_external_build(&module, cancel).await?) } else { None };
    let mut info = project.lsp.java_launch(&module, test, build && !delegated, full, delegated, cancel).await?;
    let lsp_ms = started.elapsed().as_millis();
    let data_dir = host.local_data_dir.clone();
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || {
        let _external_build = external_build;
        let built = if delegated {
            let outputs = project.java_launch_snapshots.lock().build(
                &project.root,
                &model,
                &module,
                test,
                ide_sdk::apply::maven_local_repository(&project.root, &settings),
                full,
                &cancel,
            )?;
            let copies = use_snapshot(&mut info, &outputs.originals, &outputs.snapshot);
            info.build = Some(JavaBuildStatus::Succeeded);
            info.errors.clear();
            info.error_count = 0;
            copies
        } else if external {
            compile::build_for_launch(&project.root, &model, &module, test, build_kind, &cancel)?
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
            module = %module.display(),
            test,
            policy = ?policy,
            build = ?info.build,
            classpath_entries = info.class_paths.len(),
            module_path_entries = info.module_paths.len(),
            java_exec = info.java_exec.as_deref().unwrap_or("java"),
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
) -> IdeResult<ide_lsp::jdtls::JavaBuildStatus> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let module = project.root.join(module);
    project.lsp.java_build(&module, false, &CancellationToken::new()).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("java_resolve_launch", |c| async move {
        java_resolve_launch(&c.host, &c.window, c.arg("module")?, c.arg("test")?, c.arg("policy")?, c.arg("request")?)
            .await
    });
    d.add("java_debug_server", |c| async move { java_debug_server(&c.host, &c.window, c.arg("module")?).await });
    d.add("java_build_workspace", |c| async move { java_build_workspace(&c.host, &c.window, c.arg("module")?).await });
}

#[cfg(test)]
mod tests {
    use super::*;

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
