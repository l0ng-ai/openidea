use openidea_plugin::details::ProcessLog;
use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};

const SCRIPT: &str = r#"i=0
while true; do
  i=$((i+1))
  printf 'INFO probe line %s — Unicode 日志\n' "$i"
  if [ "$1" = "--verbose" ]; then printf 'DEBUG verbose output enabled\n'; fi
  read -t 1 ignored || true
done"#;

#[derive(Default)]
struct WebLog;

impl Plugin for WebLog {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "open" | "denied" => {
                host::post_view_message("logs", id)?;
                Ok(None)
            }
            // The same stream as the page's, opened by the plugin's code.
            "code" => {
                let log = ProcessLog::new("bash", &["--noprofile", "--norc", "-c", SCRIPT, "log-probe"]).toggle(
                    "verbose",
                    "Verbose",
                    &["--verbose"],
                );
                host::open_log_tab("code", "Probe logs (code)", &log)?;
                Ok(None)
            }
            "ping" => Ok(Some("Web log ready".into())),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

register_plugin!(WebLog);
