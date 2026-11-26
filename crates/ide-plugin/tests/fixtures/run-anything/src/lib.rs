//! API 1.18 fixture for `[[contributes.runAnything]]`: `task <name>` lines are
//! suggested from a fixed task list and claimed when the task exists.
use openidea_plugin::{Error, Invocation, Plugin, RunAnything, RunAnythingItem, register_plugin};

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

register_plugin!(Fixture, run_anything);
