use openidea_plugin::commit::{CommitChecks, CommitProblem};
use openidea_plugin::{CommitDraft, Error, Invocation, Location, Plugin, Position, Range, host, register_plugin};

#[derive(Default)]
struct Fixture;

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        if id != "describe" {
            return Err(Error::NotFound(id.into()));
        }
        let draft = host::pending_commit()?.ok_or("no repository")?;
        let names: Vec<String> = draft
            .changes
            .iter()
            .map(|c| format!("{} {}", c.status, c.path.rsplit('/').next().unwrap_or(&c.path)))
            .collect();
        let message = format!("chore: {}", names.join(", "));
        host::set_commit_message(draft.revision, &message)?;
        Ok(Some(message))
    }
}

impl CommitChecks for Fixture {
    fn check(&mut self, check: &str, draft: &CommitDraft, _: &Invocation) -> Result<Vec<CommitProblem>, Error> {
        if check != "markers" {
            return Err(Error::NotFound(check.into()));
        }
        let mut problems = Vec::new();
        if !draft.message.split_once(": ").is_some_and(|(t, _)| !t.is_empty() && !t.contains(' ')) {
            problems.push(CommitProblem::new("The message does not start with `type: `."));
        }
        for change in &draft.changes {
            let Some(diff) = &change.diff else { continue };
            let mut line = 0u32;
            for l in diff.lines() {
                if let Some(hunk) = l.strip_prefix("@@ -") {
                    // `@@ -a,b +c,d @@`: c is the 1-based first line of the new side.
                    let new = hunk.split(" +").nth(1).and_then(|s| s.split([',', ' ']).next());
                    line = new.and_then(|n| n.parse::<u32>().ok()).unwrap_or(1).saturating_sub(1);
                } else if l.starts_with('+') && !l.starts_with("+++") {
                    if l.contains("DO NOT COMMIT") {
                        let at = Position::new(line, 0);
                        let location = Location { path: change.path.clone(), range: Range::new(at, at) };
                        problems.push(CommitProblem::new("Remove the DO NOT COMMIT marker.").at(location));
                    }
                    line += 1;
                } else if !l.starts_with('-') {
                    line += 1;
                }
            }
        }
        Ok(problems)
    }
}

register_plugin!(Fixture, commit_checks);
