use crate::Host;
use ide_core::path_mapping::PathMapping;
use ide_core::{IdeError, IdeResult};
use ide_dap::target::TargetMapping;
use ide_dap::{LaunchConfig, SessionOwner};
use ide_language::ProgramPin;
use serde_json::json;

pub(super) async fn start(
    host: &Host,
    window: &str,
    mut config: LaunchConfig,
    owner: SessionOwner,
    id: String,
) -> IdeResult<ide_core::DebugSessionId> {
    let project = host.project(window)?;
    let plugins =
        host.plugin_host().ok_or_else(|| IdeError::unavailable("plugin run target is no longer available"))?;
    let registration = plugins
        .run_targets(&project.root)
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| IdeError::unavailable("plugin run target is no longer available"))?;
    let container = registration
        .target
        .container_root
        .ok_or_else(|| IdeError::invalid("Debugging a plugin target requires a container root"))?;
    let dbg = ide_dap::adapter::find_config(&host.languages, &config.adapter)
        .ok_or_else(|| IdeError::invalid("unknown debug adapter"))?;
    let placement = dbg.target_placement.as_deref().unwrap_or("");
    if !matches!(placement, "connect-back" | "adapter-in-target")
        || (placement == "adapter-in-target" && dbg.transport != "stdio")
    {
        return Err(IdeError::invalid("This debugger does not support plugin run targets"));
    }
    let mapping = TargetMapping {
        paths: PathMapping::new(&project.root.to_string_lossy(), &container),
        external_prefix: format!(
            "openidea-target://{}/0/",
            percent_encoding::utf8_percent_encode(&id, percent_encoding::NON_ALPHANUMERIC)
        ),
    };
    let mut extra: serde_json::Value = config
        .extra_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| IdeError::invalid(e.to_string()))?
        .unwrap_or(json!({}));
    extra.as_object_mut().ok_or_else(|| IdeError::invalid("invalid debug launch arguments"))?.remove("__runTarget");
    // DAP paths already use target coordinates; adapter-native mappings stay identity.
    if placement == "connect-back" {
        config.program = None;
        config.args.clear();
        for key in ["program", "runtimeExecutable", "runtimeArgs"] {
            extra.as_object_mut().unwrap().remove(key);
        }
        if extra.get("port").and_then(|v| v.as_u64()).unwrap_or(0) == 0 {
            extra["port"] = json!(9003);
        }
        extra["hostname"] = json!("0.0.0.0");
        extra["pathMappings"] = json!({container.clone(): container.clone()});
    } else {
        for key in ["debugLauncherPython", "pythonPath"] {
            extra.as_object_mut().unwrap().remove(key);
        }
        extra["console"] = json!("internalConsole");
        extra["python"] = json!(dbg.command);
        extra["pathMappings"] = json!([{"localRoot":container,"remoteRoot":container}]);
    }
    config.extra_json = Some(extra.to_string());
    let wrapped = if placement == "adapter-in-target" {
        let run = serde_json::from_value(json!({"id":"debug-adapter","name":"Debug adapter","kind":"shell","command":dbg.command,"args":dbg.args,"cwd":config.cwd,"env":config.env,"detected":false,"isTest":false})).map_err(|e| IdeError::invalid(e.to_string()))?;
        let root = project.root.clone();
        Some(host.blocking(move || plugins.prepare_run_target(&root, &id, &run)).await?)
    } else {
        None
    };
    host.require_trust(window)?;
    let root = project.root.clone();
    let settings = project.settings.effective();
    host.debugger
        .start_prepared(
            config,
            owner,
            |_| None,
            move |spec, _| {
                if let Some(run) = wrapped {
                    spec.command = run.command;
                    spec.args = run.args;
                    spec.cwd = run.cwd.map(Into::into).unwrap_or(root);
                    spec.env = run.env.into_iter().collect();
                    spec.pinned = Some(ProgramPin::approve(&spec.command)?);
                } else if let Some(command) = ide_sdk::apply::tool_command(&root, &settings, &spec.command) {
                    spec.command = command.to_string_lossy().into_owned();
                }
                spec.target = Some(mapping);
                Ok(())
            },
        )
        .await
}
