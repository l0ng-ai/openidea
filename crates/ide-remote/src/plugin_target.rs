//! Shell-free argv construction for plugin-owned run targets.
use ide_core::remote_settings::PluginRunTarget;
use ide_core::{IdeError, IdeResult};
use ide_run::{RunConfig, wrap};
use std::path::Path;

/// Validates a bounded target before replacing an existing registration.
pub fn validate(target: &PluginRunTarget) -> IdeResult<()> {
    let label = |s: &str, max: usize| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control);
    if !label(&target.id, 128) || !label(&target.name, 256) || !label(&target.program, 256) {
        return Err(IdeError::invalid("invalid run target id, name or program"));
    }
    let argv = |args: &[String]| args.len() <= 256 && args.iter().all(|a| a.len() <= 16384 && !a.contains('\0'));
    let mut names = std::collections::BTreeSet::new();
    if !argv(&target.args)
        || !argv(&target.workdir_args)
        || target.commands.len() > 64
        || target.commands.iter().any(|c| {
            !label(&c.name, 256)
                || wrap::program_name(&c.name) != c.name
                || !names.insert(&c.name)
                || !argv(&c.args)
                || c.workdir_args.as_ref().is_some_and(|args| !argv(args))
        })
        || serde_json::to_vec(target).map_or(true, |v| v.len() > 256 << 10)
        || target
            .container_root
            .as_ref()
            .is_some_and(|r| !r.starts_with('/') || r.contains(['\0', '\n', '\r']) || r.split('/').any(|p| p == ".."))
    {
        return Err(IdeError::invalid("invalid run target arguments or container root"));
    }
    Ok(())
}

/// Wraps argv, keeping the local cwd and environment for the approved wrapper.
/// The wrapper decides whether to forward environment into its container.
pub fn prepare(root: &Path, target: &PluginRunTarget, program: &Path, config: &RunConfig) -> IdeResult<RunConfig> {
    validate(target)?;
    let cwd = wrap::run_dir(root, config);
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let cwd = dunce::canonicalize(&cwd).unwrap_or(cwd);
    let relative =
        cwd.strip_prefix(&root).ok().filter(|p| !p.components().any(|c| matches!(c, std::path::Component::ParentDir)));
    let mapped_cwd = target.container_root.as_deref().zip(relative).map(|(container, rel)| {
        if rel.as_os_str().is_empty() {
            container.to_owned()
        } else {
            format!("{}/{}", container.trim_end_matches('/'), rel.to_string_lossy().replace('\\', "/"))
        }
    });
    let mapped = target
        .container_root
        .as_deref()
        .map(|container| crate::target::argv_command(config, &Default::default(), &root, container));
    let command = mapped.as_ref().map_or_else(
        || {
            let p = Path::new(&config.command);
            if p.is_absolute() && !p.starts_with(&root) {
                wrap::program_name(&config.command)
            } else {
                config.command.clone()
            }
        },
        |m| m.program.clone(),
    );
    let name = wrap::program_name(&config.command);
    let command_override = target.commands.iter().find(|c| c.name == name);
    let mut args = command_override.map_or(&target.args, |c| &c.args).clone();
    let workdir_args = command_override.and_then(|c| c.workdir_args.as_ref()).unwrap_or(&target.workdir_args);
    if let Some(cwd) = mapped_cwd {
        args.extend(workdir_args.iter().map(|a| a.replace("{cwd}", &cwd)));
    }
    if command_override.is_none() {
        args.push(command);
    }
    args.extend(mapped.as_ref().map_or_else(|| config.args.clone(), |m| m.args.clone()));
    let mut result = config.clone();
    result.command = program.to_string_lossy().into_owned();
    result.args = args;
    result.cwd = Some(cwd.into());
    result.extras.target = None;
    // A wrapper's -c/-e are its own flags, not interpreter flags to inspect.
    result.kind = "shell".into();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::remote_settings::PluginCommandOverride;
    fn config(command: &str, args: &[&str], cwd: &str) -> RunConfig {
        serde_json::from_value(serde_json::json!({"id":"test", "name":"Test", "kind":"php", "command":command, "args":args, "cwd":cwd, "env":{}, "detected":false, "isTest":false})).unwrap()
    }
    #[test]
    fn prefix_override_cwd_and_literal_argv() {
        let target = PluginRunTarget {
            id: "ddev".into(),
            name: "DDEV".into(),
            program: "ddev".into(),
            args: vec!["exec".into()],
            workdir_args: vec!["--dir".into(), "{cwd}".into()],
            container_root: Some("/var/www/html".into()),
            commands: vec![PluginCommandOverride {
                name: "composer".into(),
                args: vec!["composer".into()],
                workdir_args: None,
            }],
        };
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let program = base.join("approved/ddev");
        let php = base.join("tools/php");
        let run =
            prepare(&root, &target, &program, &config(php.to_str().unwrap(), &["x.php", "$(touch bad); a b"], "src"))
                .unwrap();
        assert_eq!(Path::new(&run.command), program);
        assert_eq!(run.args, ["exec", "--dir", "/var/www/html/src", "php", "x.php", "$(touch bad); a b"]);
        assert_eq!(run.cwd.unwrap(), root.join("src"));
        let outside = base.join("outside");
        let run = prepare(
            &root,
            &target,
            &program,
            &config(r"C:\tools\composer.exe", &["install"], outside.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(run.args, ["composer", "install"]);
        let in_project = prepare(&root, &target, &program, &config("/tools/composer", &["install"], "src")).unwrap();
        assert_eq!(in_project.args, ["composer", "--dir", "/var/www/html/src", "install"]);
        let run = prepare(&root, &target, &program, &config("composer", &["install"], "../outside")).unwrap();
        assert_eq!(run.args, ["composer", "install"]);
        let mut target = target;
        target.container_root = None;
        let run = prepare(&root, &target, &program, &config("php", &["x.php"], "src")).unwrap();
        assert_eq!(run.args, ["exec", "php", "x.php"]);
        let run = prepare(&root, &target, &program, &config("echo a; touch bad", &[], ".")).unwrap();
        assert_eq!(run.args, ["exec", "echo a; touch bad"]);
    }

    #[test]
    fn per_command_workdir_arguments_replace_inherit_and_preserve_other_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir(root.join("public")).unwrap();
        for (workdir_args, expected) in [
            (Some(vec![]), vec!["composer", "install"]),
            (
                Some(vec!["--working-dir={cwd}".into(), "literal ; $(touch bad)".into()]),
                vec!["composer", "--working-dir=/var/www/html/public", "literal ; $(touch bad)", "install"],
            ),
            (None, vec!["composer", "--dir=/var/www/html/public", "--", "install"]),
        ] {
            let target = PluginRunTarget {
                id: "ddev".into(),
                name: "DDEV".into(),
                program: "ddev".into(),
                args: vec!["exec".into(), "--raw".into()],
                workdir_args: vec!["--dir={cwd}".into(), "--".into()],
                container_root: Some("/var/www/html".into()),
                commands: vec![PluginCommandOverride {
                    name: "composer".into(),
                    args: vec!["composer".into()],
                    workdir_args,
                }],
            };
            // The metadata crosses the remote protocol without losing None vs Some([]).
            let encoded = serde_json::to_vec(&target).unwrap();
            let decoded = serde_json::from_slice::<PluginRunTarget>(&encoded).unwrap();
            assert_eq!(decoded, target);
            let run = prepare(&root, &decoded, Path::new("ddev"), &config("composer", &["install"], "public")).unwrap();
            assert_eq!(run.args, expected);
            assert_eq!(run.cwd.unwrap(), root.join("public"));
            let php = prepare(&root, &target, Path::new("ddev"), &config("php", &["x.php"], "public")).unwrap();
            assert_eq!(php.args, ["exec", "--raw", "--dir=/var/www/html/public", "--", "php", "x.php"]);
            for (container_root, cwd) in [(None, "public"), (target.container_root.clone(), "../outside")] {
                let target = PluginRunTarget { container_root, ..target.clone() };
                let run = prepare(&root, &target, Path::new("ddev"), &config("composer", &["install"], cwd)).unwrap();
                assert_eq!(run.args, ["composer", "install"]);
            }
        }
    }

    #[test]
    fn override_workdir_arguments_obey_the_same_bounds() {
        let mut target = PluginRunTarget {
            id: "ddev".into(),
            name: "DDEV".into(),
            program: "ddev".into(),
            commands: vec![PluginCommandOverride { name: "composer".into(), ..Default::default() }],
            ..Default::default()
        };
        for args in
            [vec!["bad\0arg".into()], vec!["x".repeat(16385)], vec!["x".into(); 257], vec!["x".repeat(16384); 17]]
        {
            target.commands[0].workdir_args = Some(args);
            assert!(validate(&target).is_err());
        }
        target.commands[0].workdir_args = Some(vec!["x".repeat(16384)]);
        assert!(validate(&target).is_ok());
        target.commands[0].name = "path/composer".into();
        assert!(validate(&target).is_err());
        target.commands[0].name = "composer".into();
        target.commands.push(target.commands[0].clone());
        assert!(validate(&target).is_err());
    }

    #[test]
    fn command_overrides_match_both_path_separators_on_every_platform() {
        let tmp = tempfile::tempdir().unwrap();
        let target = PluginRunTarget {
            id: "ddev".into(),
            name: "DDEV".into(),
            program: "ddev".into(),
            args: vec!["exec".into()],
            workdir_args: Vec::new(),
            container_root: Some("/container".into()),
            commands: vec![PluginCommandOverride { name: "php".into(), args: vec!["php".into()], workdir_args: None }],
        };
        for command in ["php", "/usr/bin/php", r"C:\tools\php.exe", r"\\?\C:\tools\php.exe", "C:/tools/php.cmd"] {
            for container_root in [None, target.container_root.clone()] {
                let target = PluginRunTarget { container_root, ..target.clone() };
                let run = prepare(tmp.path(), &target, Path::new("ddev"), &config(command, &["x.php"], ".")).unwrap();
                assert_eq!(run.args, ["php", "x.php"], "{command}");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn plain_and_verbatim_roots_map_project_commands_and_cwds() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("src")).unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let verbatim = std::fs::canonicalize(tmp.path()).unwrap();
        let target = PluginRunTarget {
            id: "ddev".into(),
            name: "DDEV".into(),
            program: "ddev".into(),
            args: vec!["exec".into()],
            workdir_args: vec!["--dir={cwd}".into()],
            container_root: Some("/container".into()),
            commands: Vec::new(),
        };
        let command = root.join("tool.exe");
        for project in [&root, &verbatim] {
            for cwd in [root.join("src"), verbatim.join("src")] {
                let run = prepare(
                    project,
                    &target,
                    Path::new("ddev"),
                    &config(command.to_str().unwrap(), &["arg"], cwd.to_str().unwrap()),
                )
                .unwrap();
                assert_eq!(run.args, ["exec", "--dir=/container/src", "/container/tool.exe", "arg"]);
                assert_eq!(run.cwd.unwrap(), root.join("src"));
            }
        }
    }
}
