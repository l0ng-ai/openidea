use openidea_plugin::{Error, Invocation, McpProvider, Plugin, PluginDataSource, host, register_plugin};
#[derive(Default)]
struct DataTools;
impl Plugin for DataTools {
    fn run_command(&mut self, id: &str, ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        if id == "stdio" {
            return Ok(Some(serde_json::to_string(&host::mcp_stdio_command()).unwrap()));
        }
        let p = ctx.project().ok_or("project required")?;
        match id {
            "upsert" => {
                let source: PluginDataSource =
                    serde_json::from_str(arg.unwrap()).map_err(|e| Error::Invalid(e.to_string()))?;
                p.upsert_data_source(&source)?;
            }
            "remove" => p.remove_data_source(arg.unwrap_or("local"))?,
            "sources" => return Ok(Some(serde_json::to_string(&p.data_sources()?).unwrap())),
            "credential" => p.set_data_source_credential("local", arg.unwrap_or("secret"))?,
            "connect" => p.connect_data_source(arg.unwrap_or("local"))?,
            _ => return Err(Error::NotFound(id.into())),
        }
        Ok(None)
    }
}
impl McpProvider for DataTools {
    fn call(&mut self, tool: &str, arguments: &str, ctx: &Invocation) -> Result<String, Error> {
        match tool {
            "spin" => loop {
                std::hint::spin_loop();
            },
            "denied" => {
                host::run_process("sh", &[], None)?;
                Ok("unexpected".into())
            }
            _ => Ok(format!("{}:{}:{}", tool, ctx.project().ok_or("project required")?.root()?, arguments)),
        }
    }
}
register_plugin!(DataTools, mcp);
