//! Lightweight .NET project discovery; MSBuild remains the authority for build outputs.

use crate::RunConfig;
use ide_core::{IdeError, IdeResult};
use quick_xml::{Reader, XmlVersion, events::Event};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, PartialEq)]
pub struct Project {
    pub executable: bool,
    pub frameworks: Vec<String>,
    pub test: bool,
}

#[derive(Default)]
struct Element {
    name: String,
    attrs: BTreeMap<String, String>,
    text: String,
    conditional: bool,
}

fn elements(xml: &str) -> Option<Vec<Element>> {
    let mut reader = Reader::from_str(xml);
    let mut out: Vec<Element> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    loop {
        let event = reader.read_event().ok()?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(tag) | Event::Empty(tag) => {
                let attrs: BTreeMap<_, _> = tag
                    .attributes()
                    .map(|a| {
                        let a = a.ok()?;
                        Some((
                            a.key.as_ref().to_owned(),
                            a.normalized_value(XmlVersion::Implicit1_0).ok()?.into_owned(),
                        ))
                    })
                    .collect::<Option<_>>()?;
                let conditional = attrs.contains_key("Condition") || stack.last().is_some_and(|i| out[*i].conditional);
                out.push(Element {
                    name: tag.local_name().as_ref().to_owned(),
                    attrs,
                    conditional,
                    ..Default::default()
                });
                // Empty elements have no corresponding End event.
                if !empty {
                    stack.push(out.len() - 1);
                }
            }
            Event::End(_) => {
                stack.pop()?;
            }
            Event::Text(text) => {
                if let Some(i) = stack.last() {
                    out[*i].text.push_str(&text.xml_content(XmlVersion::Implicit1_0));
                }
            }
            Event::CData(text) => {
                if let Some(i) = stack.last() {
                    out[*i].text.push_str(text.as_ref());
                }
            }
            Event::GeneralRef(reference) => {
                let name = reference.as_ref();
                let escaped = format!("&{name};");
                if let Some(i) = stack.last() {
                    out[*i].text.push_str(&quick_xml::escape::unescape(&escaped).ok()?);
                }
            }
            Event::Eof => return stack.is_empty().then_some(out),
            _ => {}
        }
    }
}

pub fn parse_project(xml: &str) -> Option<Project> {
    let tags = elements(xml)?;
    if tags.first()?.name != "Project" {
        return None;
    }
    let property = |name: &str| tags.iter().rev().find(|t| t.name == name && !t.conditional).map(|t| t.text.trim());
    let web = tags.iter().any(|t| {
        t.attrs
            .get("Sdk")
            .or_else(|| (t.name == "Sdk").then(|| t.attrs.get("Name")).flatten())
            .is_some_and(|s| s.split(';').any(|sdk| sdk.split('/').next() == Some("Microsoft.NET.Sdk.Web")))
    });
    let executable = match property("OutputType") {
        Some(output) => output.eq_ignore_ascii_case("exe") || output.eq_ignore_ascii_case("winexe"),
        None => web,
    };
    let frameworks = property("TargetFramework")
        .filter(|v| !v.is_empty())
        .or_else(|| property("TargetFrameworks"))
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect();
    let test = tags.iter().any(|t| {
        t.name == "PackageReference"
            && t.attrs
                .get("Include")
                .or_else(|| t.attrs.get("Update"))
                .is_some_and(|v| v.eq_ignore_ascii_case("Microsoft.NET.Test.Sdk"))
    });
    Some(Project { executable, frameworks, test })
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub command_name: String,
    pub command_line_args: String,
    pub working_directory: String,
    pub application_url: String,
    pub environment_variables: BTreeMap<String, String>,
}

pub fn parse_profiles(json: &str) -> BTreeMap<String, Profile> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&ide_core::jsonc::strip(json)) else {
        return BTreeMap::new();
    };
    json["profiles"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, value)| {
            let profile: Profile = serde_json::from_value(value.clone()).ok()?;
            (profile.command_name == "Project").then(|| (name.clone(), profile))
        })
        .collect()
}

pub fn solution_projects(src: &str, xml: bool) -> Vec<PathBuf> {
    let paths: Vec<String> = if xml {
        elements(src)
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.name == "Project")
            .filter_map(|mut e| e.attrs.remove("Path"))
            .collect()
    } else {
        src.lines()
            .filter_map(|line| {
                let line = line.trim();
                if !line.starts_with("Project(") {
                    return None;
                }
                Some(line.split_once('=')?.1.split('"').nth(3)?.to_owned())
            })
            .collect()
    };
    paths
        .into_iter()
        .filter(|p| p.to_ascii_lowercase().ends_with(".csproj"))
        .map(|p| PathBuf::from(p.replace('\\', "/")))
        .collect()
}

pub(crate) fn profiles(project: &Path) -> BTreeMap<String, Profile> {
    project
        .parent()
        .and_then(|p| fs::read_to_string(p.join("Properties/launchSettings.json")).ok())
        .map(|s| parse_profiles(&s))
        .unwrap_or_default()
}

/// Resolves the selected profile afresh so changing project/profile never reuses stale values.
pub fn resolve(root: &Path, mut config: RunConfig) -> IdeResult<RunConfig> {
    let params = &config.extras.params;
    let project = params
        .get("project")
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| IdeError::invalid("Select a .NET project"))?;
    let project = dunce::canonicalize(root.join(project))?;
    let dir = project.parent().ok_or_else(|| IdeError::invalid("Invalid .NET project path"))?;
    let profile_name = params.get("launchProfile").cloned().unwrap_or_default();
    let profile = if profile_name.is_empty() {
        Profile::default()
    } else {
        profiles(&project).remove(&profile_name).ok_or_else(|| {
            IdeError::invalid(format!(".NET launch profile '{profile_name}' is missing or is not a Project profile"))
        })?
    };
    let mut env = profile.environment_variables;
    if !profile.application_url.is_empty() {
        env.insert("ASPNETCORE_URLS".into(), profile.application_url);
    }
    if !profile_name.is_empty() {
        env.insert("DOTNET_LAUNCH_PROFILE".into(), profile_name);
    }
    env.extend(config.env);
    config.env = env;
    config.cwd = Some(
        config
            .cwd
            .map(|p| root.join(&*p))
            .unwrap_or_else(|| {
                if profile.working_directory.is_empty() { dir.into() } else { dir.join(&profile.working_directory) }
            })
            .into(),
    );
    config.extras.params.insert("project".into(), project.to_string_lossy().into_owned());
    config.extras.params.insert("profileArgs".into(), profile.command_line_args);
    Ok(config)
}

/// Queries the evaluated output path, including AssemblyName, OutputPath and imported properties.
pub async fn target_path(root: &Path, config: &RunConfig) -> IdeResult<String> {
    let params = &config.extras.params;
    let project = params.get("project").ok_or_else(|| IdeError::invalid("Select a .NET project"))?;
    let mut args = vec![
        "msbuild".to_owned(),
        root.join(project).to_string_lossy().into_owned(),
        "-nologo".into(),
        "-getProperty:TargetPath".into(),
        "-p:Configuration=Debug".into(),
    ];
    if let Some(framework) = params.get("framework").filter(|s| !s.is_empty()) {
        args.push(format!("-p:TargetFramework={framework}"));
    }
    let mut command = std::process::Command::new(&config.command);
    ide_core::process::host_env(&mut command);
    command.args(args).current_dir(root);
    if !config.extras.include_system_env {
        command.env_clear();
    } else {
        command.envs(ide_core::process::shell_env());
    }
    command.envs(crate::resolved_env(root, config)?);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| IdeError::unavailable(".NET output resolution timed out"))??;
    if !output.status.success() {
        return Err(IdeError::invalid(format!(
            ".NET output resolution failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let target = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if target.is_empty() || !Path::new(&target).is_file() {
        return Err(IdeError::invalid(".NET build output is missing; run dotnet build before debugging"));
    }
    Ok(target)
}
