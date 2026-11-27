//! Pending changelists of a workspace, their shelves and the jobs they fix.

use crate::cli::{args, unescape};
use crate::ops::OperationResult;
use crate::workspace::{OpenedFile, Workspace};
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// A pending changelist of this workspace with the files opened in it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingChangelist {
    /// 0 is the default changelist.
    pub number: u32,
    pub description: String,
    pub time_ms: f64,
    pub files: Vec<OpenedFile>,
    /// It has shelved files.
    pub shelved: bool,
}

/// A file in the shelf of a changelist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShelvedFile {
    pub depot_file: String,
    /// Workspace-relative path, when the client view maps the file.
    pub rel_path: Option<String>,
    pub action: String,
    pub rev: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub name: String,
    pub status: String,
    pub user: String,
    pub description: String,
}

impl Workspace {
    /// The default changelist and every numbered pending one of this client, oldest first.
    pub fn changelists(&self) -> IdeResult<Vec<PendingChangelist>> {
        let client = &self.connection().client;
        let pending = self.tagged(&args(["changes", "-l", "-s", "pending", "-c", client]))?;
        let shelved: Vec<u32> = self
            .tagged(&args(["changes", "-s", "shelved", "-c", client]))?
            .records
            .iter()
            .filter_map(|r| r.num("change"))
            .collect();
        let mut lists = vec![PendingChangelist {
            number: 0,
            description: String::new(),
            time_ms: 0.0,
            files: Vec::new(),
            shelved: false,
        }];
        for r in &pending.records {
            let Some(number) = r.num("change") else { continue };
            lists.push(PendingChangelist {
                number,
                description: r.text("desc").trim_end().to_owned(),
                time_ms: r.get("time").and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.0) * 1000.0,
                files: Vec::new(),
                shelved: shelved.contains(&number),
            });
        }
        lists.sort_by_key(|l| l.number);
        for file in self.opened(&[])? {
            if let Some(list) = lists.iter_mut().find(|l| l.number == file.change) {
                list.files.push(file);
            }
        }
        Ok(lists)
    }

    /// Writes a changelist form; `number` `None` makes a new one. Returns its number.
    fn save_changelist(&self, number: Option<u32>, description: &str) -> IdeResult<u32> {
        let connection = self.connection();
        let mut form = String::new();
        let mut extra = Vec::new();
        match number {
            Some(number) => {
                let out = self.tagged(&args(["change", "-o", &number.to_string()]))?;
                let Some(spec) = out.records.first() else {
                    return Err(IdeError::not_found(format!("changelist {number} does not exist")));
                };
                form.push_str(&format!("Change:\t{number}\n\nStatus:\tpending\n\n"));
                for field in ["Type", "Stream"] {
                    if let Some(value) = spec.get(field) {
                        form.push_str(&format!("{field}:\t{value}\n\n"));
                    }
                }
                for (field, values) in [("Jobs", spec.list("Jobs")), ("Files", spec.list("Files"))] {
                    if !values.is_empty() {
                        extra.push(format!(
                            "{field}:\n{}\n",
                            values.iter().map(|v| format!("\t{v}\n")).collect::<String>()
                        ));
                    }
                }
            }
            None => form.push_str("Change:\tnew\n\nStatus:\tnew\n\n"),
        }
        form.push_str(&format!("Client:\t{}\n\nUser:\t{}\n\nDescription:\n", connection.client, connection.user));
        let description = if description.trim().is_empty() { "<no description>" } else { description };
        for line in description.lines() {
            form.push_str(&format!("\t{line}\n"));
        }
        form.push('\n');
        form.extend(extra);
        let out = self.raw_with(&args(["change", "-i"]), form.as_bytes())?;
        // "Change 12 created." / "Change 12 updated."
        let said = String::from_utf8_lossy(&out);
        said.split_whitespace()
            .nth(1)
            .and_then(|n| n.parse().ok())
            .or(number)
            .ok_or_else(|| IdeError::internal(format!("p4 change: {}", said.trim())))
    }

    /// Makes a pending changelist and moves `files` (already opened) into it.
    pub fn create_changelist(&self, description: &str, files: &[PathBuf]) -> IdeResult<u32> {
        let number = self.save_changelist(None, description)?;
        if !files.is_empty()
            && let Err(e) = self.reopen(files, number)
        {
            let _ = self.delete_changelist(number);
            return Err(e);
        }
        Ok(number)
    }

    pub fn update_changelist(&self, number: u32, description: &str) -> IdeResult<()> {
        if number == 0 {
            return Err(IdeError::invalid("the default changelist has no description"));
        }
        self.save_changelist(Some(number), description).map(|_| ())
    }

    /// Deletes an empty pending changelist (no opened or shelved files).
    pub fn delete_changelist(&self, number: u32) -> IdeResult<()> {
        self.raw(&args(["change", "-d", &number.to_string()])).map(|_| ())
    }

    /// Moves opened files to another changelist (0 = default).
    pub fn reopen(&self, paths: &[PathBuf], change: u32) -> IdeResult<()> {
        self.require_inside(paths)?;
        let target = if change == 0 { "default".to_owned() } else { change.to_string() };
        self.each_batch(&["reopen", "-c", &target], &self.file_args(paths)).map(|_| ())
    }

    /// Shelves files of a numbered changelist (`paths` empty = all of it),
    /// replacing what its shelf holds for them.
    pub fn shelve(&self, change: u32, paths: &[PathBuf]) -> IdeResult<OperationResult> {
        if change == 0 {
            return Err(IdeError::invalid("files of the default changelist are shelved through a numbered one"));
        }
        let number = change.to_string();
        let out = if paths.is_empty() {
            self.tagged(&args(["shelve", "-r", "-c", &number]))?
        } else {
            self.each_batch(&["shelve", "-f", "-c", &number], &self.file_args(paths))?
        };
        Ok(OperationResult { files: Vec::new(), messages: out.messages })
    }

    /// The files in the shelf of a changelist.
    pub fn shelved_files(&self, change: u32) -> IdeResult<Vec<ShelvedFile>> {
        let files = match self.change_files(&format!("shelved:{change}")) {
            Ok(files) => files,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let local = self.local_paths(&files.iter().map(|(f, _, _)| f.clone()).collect::<Vec<_>>())?;
        Ok(files
            .into_iter()
            .map(|(depot_file, action, rev)| ShelvedFile {
                rel_path: local.get(&depot_file).map(|p| self.rel(p)),
                depot_file,
                action,
                rev,
            })
            .collect())
    }

    /// Restores shelved files of `source` into `target` (`None` = the changelist they were shelved from).
    pub fn unshelve(
        &self,
        source: u32,
        target: Option<u32>,
        depot_files: &[String],
        force: bool,
    ) -> IdeResult<OperationResult> {
        let mut argv = args(["unshelve", "-s", &source.to_string()]);
        if force {
            argv.push("-f".to_owned());
        }
        match target {
            Some(0) => argv.extend(args(["-c", "default"])),
            Some(number) => argv.extend(args(["-c", &number.to_string()])),
            None => argv.extend(args(["-c", &source.to_string()])),
        }
        argv.extend(depot_files.iter().map(|d| crate::cli::escape(std::path::Path::new(d))));
        let out = self.tagged(&argv)?;
        self.invalidate();
        let files = out
            .records
            .iter()
            .filter(|r| r.has("depotFile"))
            .map(|r| crate::ops::AffectedFile {
                path: None,
                depot_file: unescape(r.get("depotFile").unwrap_or_default()),
                action: r.text("action"),
                rev: r.num("rev"),
            })
            .collect();
        Ok(OperationResult { files, messages: out.messages })
    }

    /// Deletes shelved files of a changelist (`depot_files` empty = its whole shelf).
    pub fn delete_shelf(&self, change: u32, depot_files: &[String]) -> IdeResult<()> {
        let mut argv = args(["shelve", "-d", "-c", &change.to_string()]);
        argv.extend(depot_files.iter().map(|d| crate::cli::escape(std::path::Path::new(d))));
        self.tagged(&argv).map(|_| ())
    }

    /// Jobs matching a jobview expression (`None` = the newest ones).
    pub fn jobs(&self, query: Option<&str>, limit: u32) -> IdeResult<Vec<Job>> {
        let mut argv = args(["jobs", "-l", "-r", "-m", &limit.max(1).to_string()]);
        if let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) {
            argv.extend(args(["-e", query]));
        }
        Ok(self
            .tagged(&argv)?
            .records
            .iter()
            .map(|r| Job {
                name: r.text("Job"),
                status: r.text("Status"),
                user: r.text("User"),
                description: r.text("Description").trim_end().to_owned(),
            })
            .collect())
    }

    /// The jobs a changelist fixes.
    pub fn fixes(&self, change: u32) -> IdeResult<Vec<String>> {
        let out = self.tagged(&args(["fixes", "-c", &change.to_string()]))?;
        Ok(out.records.iter().map(|r| r.text("Job")).collect())
    }

    /// Links (or with `remove`, unlinks) jobs and a changelist.
    pub fn fix(&self, change: u32, jobs: &[String], remove: bool) -> IdeResult<()> {
        if jobs.is_empty() {
            return Ok(());
        }
        let mut argv = args(["fix"]);
        if remove {
            argv.push("-d".to_owned());
        }
        argv.extend(args(["-c", &change.to_string()]));
        argv.extend(jobs.iter().cloned());
        self.tagged(&argv).map(|_| ())
    }
}
