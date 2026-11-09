//! Project language-server targets, shared by desktop and openidea-server.
use crate::plugins::PluginHost;
use ide_core::{IdeError, IdeResult};
use ide_language::{LanguageServerConfig, ServerTarget};
use std::path::Path;

pub(crate) fn configure(
    plugins: &PluginHost,
    root: &Path,
    id: &str,
    cfg: &mut LanguageServerConfig,
) -> IdeResult<bool> {
    let Some(registration) = plugins.run_targets(root).into_iter().find(|t| t.id == id) else { return Ok(false) };
    let container_root = registration.target.container_root.clone().unwrap_or_default();
    cfg.target = Some(ServerTarget {
        id: id.into(),
        origin: None,
        project_root: root.into(),
        container_root: container_root.clone(),
        mapping: ide_core::path_mapping::PathMapping::new(&root.to_string_lossy(), &container_root),
    });
    if container_root.is_empty() {
        return Err(IdeError::invalid("language server targets require a container root"));
    }
    let run = command(&cfg.command, cfg.args.clone());
    let wrapped = plugins.prepare_run_target(root, id, &run)?;
    cfg.command = wrapped.command;
    cfg.args = wrapped.args;
    cfg.connect = None;
    cfg.pinned = Some(ide_language::ProgramPin::approve(&cfg.command)?);
    Ok(true)
}

fn command(command: &str, args: Vec<String>) -> ide_run::RunConfig {
    serde_json::from_value(serde_json::json!({
        "id":"language-server", "name":"Language server", "kind":"shell",
        "command":command, "args":args, "cwd":".", "env":{}, "detected":false, "isTest":false
    }))
    .expect("valid internal run configuration")
}

pub(crate) fn read(plugins: &PluginHost, target: &ServerTarget, path: &str) -> IdeResult<String> {
    let registration = plugins
        .run_targets(&target.project_root)
        .into_iter()
        .find(|t| t.id == target.id)
        .ok_or_else(|| IdeError::unavailable("plugin run target is no longer available"))?;
    if registration.target.container_root.as_deref() != Some(&target.container_root) {
        return Err(IdeError::unavailable("plugin run target changed; navigate again"));
    }
    let mut wrapped = plugins.prepare_run_target(&target.project_root, &target.id, &command("cat", Vec::new()))?;
    wrapped.args.extend(["--".into(), path.into()]);
    capture(&wrapped, &target.project_root)
}

/// Bounds both output and time, and always kills/reaps the wrapper on failure.
fn capture(run: &ide_run::RunConfig, root: &Path) -> IdeResult<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    const LIMIT: u64 = 4 * 1024 * 1024;
    let mut cmd = Command::new(&run.command);
    ide_core::process::prepare(&mut cmd);
    ide_core::process::own_group(&mut cmd);
    let mut child = cmd
        .args(&run.args)
        .current_dir(root)
        .envs(ide_core::process::shell_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let overflow = Arc::new(AtomicBool::new(false));
    let large = overflow.clone();
    let output = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(LIMIT + 1).read_to_end(&mut bytes);
        large.store(bytes.len() as u64 > LIMIT, Ordering::Release);
        result.map(|_| bytes)
    });
    let errors = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut bytes = Vec::new();
        let _ = (&mut stderr).take(65536).read_to_end(&mut bytes);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        bytes
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let status = loop {
        if output.is_finished()
            && errors.is_finished()
            && let Ok(Some(status)) = child.try_wait()
        {
            break Ok(status);
        }
        match (std::time::Instant::now() < deadline, overflow.load(Ordering::Acquire)) {
            (true, false) => std::thread::sleep(std::time::Duration::from_millis(10)),
            _ => {
                ide_core::process::kill_tree_of(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break Err(IdeError::unavailable("container document exceeds the size or time limit"));
            }
        }
    };
    let bytes = output.join().map_err(|_| IdeError::unavailable("container document reader failed"))??;
    let stderr = errors.join().unwrap_or_default();
    if !status?.success() {
        return Err(IdeError::unavailable(format!("container document: {}", String::from_utf8_lossy(&stderr))));
    }
    if bytes.len() as u64 > LIMIT {
        return Err(IdeError::invalid("container document exceeds 4 MiB"));
    }
    String::from_utf8(bytes).map_err(|_| IdeError::invalid("container document is not UTF-8 text"))
}
