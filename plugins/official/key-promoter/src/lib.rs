//! Key Promoter for OpenIDEA: when you run an action with the mouse (menu,
//! toolbar, context menu) that has a keyboard shortcut, it tells you the
//! shortcut. Counts persist in storage, so the tips survive restarts and the
//! instance being reclaimed while you work.

use openidea_plugin::host::{self, storage};
use openidea_plugin::{ActionSource, Event, Invocation, NotificationLevel, Plugin, register_plugin};

/// Tips for one action are shown on these counts, then every `REPEAT_EVERY`.
const FIRST_TIPS: [u32; 3] = [1, 3, 10];
const REPEAT_EVERY: u32 = 25;
const COUNT: &str = "count:";
const TITLE: &str = "title:";
const SUPPRESSED: &str = "suppressed:";
const LAST: &str = "last-action";

#[derive(Default)]
pub struct KeyPromoter;

fn get_u32(key: &str) -> u32 {
    storage::get(key).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0)
}

impl Plugin for KeyPromoter {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, String> {
        match id {
            "statistics" => {
                let mut rows: Vec<(u32, String)> = storage::keys(COUNT)?
                    .into_iter()
                    .map(|k| {
                        let action = &k[COUNT.len()..];
                        let title = storage::get(&format!("{TITLE}{action}"))
                            .ok()
                            .flatten()
                            .unwrap_or_else(|| action.to_owned());
                        (get_u32(&k), title)
                    })
                    .collect();
                rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
                let body = if rows.is_empty() {
                    "No missed shortcuts yet.".to_owned()
                } else {
                    rows.iter().take(15).map(|(n, t)| format!("{n}× {t}")).collect::<Vec<_>>().join("\n")
                };
                host::notify(NotificationLevel::Info, "Key Promoter: missed shortcuts", &body);
                Ok(Some(body))
            }
            "reset" => {
                for k in storage::keys("")? {
                    storage::delete(&k)?;
                }
                Ok(Some("Key Promoter statistics were reset.".into()))
            }
            "suppress-last" => {
                let action = storage::get(LAST)?.ok_or("no tip was shown yet")?;
                storage::set(&format!("{SUPPRESSED}{action}"), "1")?;
                Ok(Some(format!("No more tips for {action}.")))
            }
            _ => Err(format!("unknown command {id}")),
        }
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        // One tip per batch at most: the last action that deserves one.
        let mut tip = None;
        for e in events {
            let Event::ActionPerformed(a) = e else { continue };
            if a.source == ActionSource::Keyboard {
                continue;
            }
            let Some(shortcut) = &a.shortcut else { continue };
            if storage::get(&format!("{SUPPRESSED}{}", a.action)).ok().flatten().is_some() {
                continue;
            }
            let key = format!("{COUNT}{}", a.action);
            let n = get_u32(&key) + 1;
            if storage::set(&key, &n.to_string()).is_err() {
                return; // storage denied or full: nothing to count with
            }
            let _ = storage::set(&format!("{TITLE}{}", a.action), &a.title);
            if FIRST_TIPS.contains(&n) || n % REPEAT_EVERY == 0 {
                tip = Some((a.clone(), shortcut.clone(), n));
            }
        }
        if let Some((a, shortcut, n)) = tip {
            let _ = storage::set(LAST, &a.action);
            let times = if n == 1 { "once".to_owned() } else { format!("{n} times") };
            host::notify(
                NotificationLevel::Info,
                &format!("{}: {shortcut}", a.title),
                &format!("You ran it with the mouse {times}. Press {shortcut} next time."),
            );
        }
    }
}

register_plugin!(KeyPromoter);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::ActionPerformed;
    use openidea_plugin::mock::MockHost;

    fn action(id: &str, source: ActionSource, shortcut: Option<&str>) -> Event {
        Event::ActionPerformed(ActionPerformed {
            action: id.into(),
            title: format!("Title of {id}"),
            source,
            shortcut: shortcut.map(str::to_owned),
        })
    }

    #[test]
    fn tips_for_mouse_use_of_actions_with_shortcuts() {
        let host = MockHost::install();
        let ctx = host.invocation();
        let mut p = KeyPromoter;
        p.handle_events(
            &[
                action("a", ActionSource::Keyboard, Some("Ctrl+A")),
                action("b", ActionSource::Menu, None),
                action("c", ActionSource::Toolbar, Some("Ctrl+C")),
            ],
            &ctx,
        );
        let notes = host.notifications();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].title, "Title of c: Ctrl+C");
        assert!(notes[0].body.contains("once"));
        // Second use: counted, no tip (next at 3).
        p.handle_events(&[action("c", ActionSource::Menu, Some("Ctrl+C"))], &ctx);
        assert_eq!(host.notifications().len(), 1);
        p.handle_events(&[action("c", ActionSource::Menu, Some("Ctrl+C"))], &ctx);
        assert!(host.notifications()[1].body.contains("3 times"));
        assert_eq!(host.storage()["count:c"], "3");
    }

    #[test]
    fn statistics_survive_a_new_instance_and_can_be_suppressed() {
        let host = MockHost::install();
        let ctx = host.invocation();
        KeyPromoter.handle_events(&[action("x", ActionSource::Menu, Some("F2"))], &ctx);
        // A fresh instance (after idle reclaim) reads the counts back.
        let stats = KeyPromoter.run_command("statistics", &ctx, None).unwrap().unwrap();
        assert_eq!(stats, "1× Title of x");
        KeyPromoter.run_command("suppress-last", &ctx, None).unwrap();
        KeyPromoter.handle_events(&vec![action("x", ActionSource::Menu, Some("F2")); 2], &ctx);
        assert_eq!(host.notifications().len(), 2, "the tip and the statistics; none after suppressing");
        KeyPromoter.run_command("reset", &ctx, None).unwrap();
        assert!(host.storage().is_empty());
    }

    #[test]
    fn without_storage_it_stays_quiet() {
        let host = MockHost::install().with_capabilities(&["events.input"]);
        KeyPromoter.handle_events(&[action("x", ActionSource::Menu, Some("F2"))], &host.invocation());
        assert!(host.notifications().is_empty());
        assert!(KeyPromoter.run_command("statistics", &host.invocation(), None).unwrap_err().contains("storage"));
    }
}
