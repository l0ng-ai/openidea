//! Test fixture: a tree of the jobs `jobs list` prints (one per line, through
//! the pinned `process:jobs`), and a terminal running `jobs follow <job>` for
//! the activated one, titled and sized by the plugin's settings.

use openidea_plugin::host;
use openidea_plugin::views::{Body, Button, TreeItem, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, NotificationLevel, PickItem, Plugin, register_plugin};

pub const VIEW: &str = "jobs";

#[derive(Default)]
pub struct Jobs {
    selected: Option<String>,
}

fn list() -> Result<Vec<String>, Error> {
    let out = host::run_process("jobs", &["list".to_owned()], None)?;
    if out.status != Some(0) {
        return Err(Error::Failed(out.stderr.trim().to_owned()));
    }
    Ok(out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

impl Jobs {
    fn follow(&self) -> Result<(), Error> {
        let job = self.selected.as_deref().ok_or_else(|| Error::Invalid("select a job first".into()))?;
        let title = host::setting_string("title").unwrap_or_else(|| "follow: ".into());
        let lines = host::setting_number("lines").map_or(20, |n| n.max(0.0) as u64);
        let args = ["follow".to_owned(), job.to_owned(), format!("--lines={lines}")];
        host::open_terminal(&format!("{title}{job}"), "jobs", &args)
    }
}

impl Plugin for Jobs {
    fn run_command(&mut self, id: &str, ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "follow" => self.follow().map(|()| None),
            "remotes" => {
                let project = ctx.project().ok_or("no project is open")?;
                let remotes = project.vcs_remotes()?;
                Ok(Some(remotes.into_iter().map(|(n, u)| format!("{n}={u}")).collect::<Vec<_>>().join("\n")))
            }
            "context" => {
                // `key=` removes; `true` / `false`, numbers and other text set.
                let (key, value) = arg.unwrap_or_default().split_once('=').ok_or("expected key=value")?;
                match value {
                    "" => host::remove_context(key),
                    "true" | "false" => host::set_context(key, value == "true")?,
                    _ => match value.parse::<f64>() {
                        Ok(n) => host::set_context(key, n)?,
                        Err(_) => host::set_context(key, value)?,
                    },
                }
                Ok(None)
            }
            "notify-actions" => {
                if arg == Some("plain") {
                    host::notify(NotificationLevel::Info, "Choose an action", "A plugin notification");
                    return Ok(None);
                }
                use openidea_plugin::NotificationAction;
                let command = if arg == Some("unknown") { "not-declared" } else { "context" };
                let count = if arg == Some("four") { 4 } else { 3 };
                let actions = (0..count)
                    .map(|i| {
                        NotificationAction::new(format!("Action {}", i + 1), command)
                            .argument(format!("notification-action={}\nvalue", i + 1))
                    })
                    .collect::<Vec<_>>();
                host::notify_with_actions(
                    NotificationLevel::Info,
                    "Choose an action",
                    "A plugin notification",
                    &actions,
                );
                Ok(None)
            }
            "copy" => {
                host::copy_to_clipboard(arg.unwrap_or_default())?;
                Ok(None)
            }
            "open-url" => {
                host::open_url(arg.unwrap_or_default())?;
                Ok(None)
            }
            "pick" | "pick-many" => {
                let long_key = "k".repeat(300);
                let items = [
                    PickItem::new(if arg == Some("long-key") { &long_key } else { "a" }, "Alpha").description("first"),
                    PickItem::new("b", "Beta"),
                    PickItem::new("c", "Gamma"),
                ];
                let picked = match id {
                    "pick" => host::pick("Pick", &items)?.map(|key| vec![key]),
                    _ => host::pick_many("Pick", &items)?,
                };
                Ok(Some(picked.map_or("none".to_owned(), |keys| keys.join(","))))
            }
            "input" => Ok(Some(host::input("Name", arg)?.unwrap_or_else(|| "none".to_owned()))),
            "confirm" => Ok(Some(host::confirm("Delete", "Really?")?.to_string())),
            "reveal" => host::reveal_view(arg.unwrap_or_default()).map(|()| None),
            "selection" => {
                let paths = ctx.selected_paths().join("\n");
                host::notify(NotificationLevel::Info, "Selected paths", &paths);
                Ok(Some(paths))
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }
}

impl Views for Jobs {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        let follow = Button::new("follow", "Follow").icon("terminal").enabled(self.selected.is_some());
        Ok(match list() {
            Ok(jobs) => View::new(Body::Tree(jobs.iter().map(|j| TreeItem::new(j, j).icon("run")).collect())),
            Err(e) => View::message(&format!("jobs: {e}")),
        }
        .button(follow))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        match event {
            ViewEvent::Select(key) => self.selected = Some(key),
            ViewEvent::Activate(key) => {
                self.selected = Some(key);
                return self.follow();
            }
            ViewEvent::Button(b) if b == "follow" => return self.follow(),
            ViewEvent::Button(b) if b == "log" => return host::open_location("jobs.log", 2, 4),
            ViewEvent::Button(b) if b == "outside" => return host::open_location("../outside.log", 0, 0),
            _ => return Ok(()),
        }
        host::refresh_view(VIEW);
        Ok(())
    }
}

register_plugin!(Jobs, views);
