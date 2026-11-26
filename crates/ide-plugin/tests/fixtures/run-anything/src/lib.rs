//! API 1.18 fixture for `[[contributes.runAnything]]`: `task <name>` lines are
//! suggested from a fixed task list and claimed when the task exists. The `tasks`
//! run configuration completes task names in its Arguments field.
use openidea_plugin::{
    Error, Invocation, Plugin, RunAnything, RunAnythingItem, RunConfigurationCompletion,
    RunConfigurationCompletionItem, register_plugin,
};

const TASKS: [&str; 3] = ["build", "test", "docs:serve"];

#[derive(Default)]
struct Fixture {
    ran: Vec<String>,
}

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            // What `run` claimed so far, for the host test.
            "ran" => Ok(Some(self.ran.join("\n"))),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

impl RunAnything for Fixture {
    fn suggest(&mut self, _project: &str, prefix: &str, text: &str) -> Vec<RunAnythingItem> {
        let typed = text.strip_prefix(prefix).unwrap_or_default().trim_start();
        TASKS
            .iter()
            .filter(|t| t.starts_with(typed))
            .map(|t| RunAnythingItem {
                label: format!("{prefix} {t}"),
                detail: Some("Taskfile.yml".into()),
                line: None,
            })
            .collect()
    }

    fn run(&mut self, _project: &str, prefix: &str, line: &str) -> bool {
        let task = line.strip_prefix(prefix).unwrap_or_default().trim();
        if !TASKS.contains(&task) {
            return false;
        }
        self.ran.push(task.into());
        true
    }
}

impl RunConfigurationCompletion for Fixture {
    /// Task names for the argument under the caret, replacing only that argument; nothing
    /// after `--` (the task's own arguments) or for another field or configuration.
    fn complete(
        &mut self,
        _project: &str,
        config: &str,
        field: &str,
        text: &str,
        caret: u32,
    ) -> Vec<RunConfigurationCompletionItem> {
        if config != "tasks" || field != "arguments" {
            return Vec::new();
        }
        let units: Vec<u16> = text.encode_utf16().collect();
        let caret = (caret as usize).min(units.len());
        let is_space = |u: u16| u == b' ' as u16 || u == b'\t' as u16;
        let start = units[..caret].iter().rposition(|&u| is_space(u)).map_or(0, |i| i + 1);
        let end = units[caret..].iter().position(|&u| is_space(u)).map_or(units.len(), |i| caret + i);
        let before = String::from_utf16_lossy(&units[..start]);
        if before.split_whitespace().any(|w| w == "--") {
            return Vec::new();
        }
        let typed = String::from_utf16_lossy(&units[start..caret]);
        if typed.starts_with('-') {
            return Vec::new();
        }
        TASKS
            .iter()
            .filter(|t| t.starts_with(typed.as_str()))
            .map(|t| RunConfigurationCompletionItem {
                label: (*t).into(),
                detail: Some("Taskfile.yml".into()),
                insert: None,
                replace_start: start as u32,
                replace_end: end as u32,
            })
            .collect()
    }
}

register_plugin!(Fixture, run_anything, run_configuration_completion);
