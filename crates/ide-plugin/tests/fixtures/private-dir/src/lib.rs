use openidea_plugin::{Context, Error, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct PrivateDir;

impl Plugin for PrivateDir {
    fn activate(&mut self, _: &Context) -> Result<(), Error> {
        // Activation has no project or focused window.
        host::fs::plugin_dir().map(drop)
    }

    fn run_command(&mut self, id: &str, _: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        let dir = host::fs::plugin_dir()?;
        let path = format!("{dir}/fake-secret.txt");
        match id {
            "directory" => Ok(Some(dir)),
            "roundtrip" => {
                host::fs::write_file(&path, "fake private data\n")?;
                let bytes = host::fs::read_bytes(&path)?;
                host::fs::write_bytes(&format!("{dir}/cache.bin"), &bytes)?;
                if host::fs::stat(&path)?.size != bytes.len() as u64 || host::fs::read_dir(&dir)?.len() < 2 {
                    return Err("private filesystem roundtrip failed".into());
                }
                host::fs::read_file(&path).map(Some)
            }
            "read" => host::fs::read_file(arg.unwrap_or(&path)).map(Some),
            "write" => host::fs::write_file(arg.unwrap_or(&path), "fake replacement\n").map(|()| None),
            "open" => host::open_location(&path, 0, 0).map(|()| Some(path)),
            "process" => host::run_process("cat", &[path], None).map(|out| Some(out.stdout)),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

impl openidea_plugin::providers::Providers for PrivateDir {
    fn completion(
        &mut self,
        _: &openidea_plugin::providers::Document,
        _: openidea_plugin::Position,
        _: Option<&str>,
    ) -> Vec<openidea_plugin::providers::CompletionItem> {
        let Ok(dir) = host::fs::plugin_dir() else { return Vec::new() };
        let path = format!("{dir}/fake-secret.txt");
        let Ok(text) = host::fs::read_file(&path) else { return Vec::new() };
        // Providers may read their content but must not open an editor.
        if host::open_location(&path, 0, 0).is_ok() {
            return Vec::new();
        }
        vec![openidea_plugin::providers::CompletionItem::new(&text, openidea_plugin::providers::CompletionKind::Text)]
    }
}

register_plugin!(PrivateDir, providers);
