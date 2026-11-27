use openidea_plugin::{DependencyStatus, Error, Invocation, Plugin, register_plugin};

#[derive(Default)]
struct BuildGraph;

impl Plugin for BuildGraph {
    fn run_command(&mut self, id: &str, inv: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        if id != "dependencies" {
            return Err(Error::NotFound(id.into()));
        }
        let project = inv.project().ok_or("no project")?;
        // One line per node: `parent group:artifact:version scope status requested`.
        let lines: Vec<String> = project
            .build_dependencies(arg.filter(|m| !m.is_empty()))?
            .into_iter()
            .map(|n| {
                let status = match n.status {
                    DependencyStatus::Resolved => "resolved",
                    DependencyStatus::OmittedForConflict => "conflict",
                    DependencyStatus::OmittedForDuplicate => "duplicate",
                    DependencyStatus::VersionManaged => "managed",
                };
                let parent = n.parent.map_or("-".into(), |p| p.to_string());
                let requested = n.requested_version.unwrap_or_else(|| "-".into());
                format!("{parent} {}:{}:{} {} {status} {requested}", n.group, n.artifact, n.version, n.scope)
            })
            .collect();
        Ok(Some(lines.join("\n")))
    }
}

register_plugin!(BuildGraph);
