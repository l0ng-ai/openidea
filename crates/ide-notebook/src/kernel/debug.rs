//! A notebook kernel's debugger as a DAP stream, for the IDE's DAP client.
//!
//! The kernel compiles each cell's code as a file of its own (`<tmp>/<hash of the code>.py`).
//! Once the debugger starts, every cell's code is sent with `dumpCell`, which writes that file
//! and names it. Paths are then rewritten both ways: the IDE's cell URIs to the kernel's files
//! in requests, the kernel's files to cell URIs in responses and events.

use super::KernelDebugger;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc;

/// DAP messages larger than this end the session (a kernel reply is far smaller).
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// Sequence numbers of the bridge's own requests, above any the IDE uses.
const OWN_SEQ: i64 = 1 << 40;
use super::transport::CANNOT_DEBUG;
/// A kernel that has a debugger but could not start it (debugpy failed).
const NOT_STARTED: &str = "the kernel could not start its debugger (debugpy)";

/// Starts the bridge; the IDE reads and writes DAP on the returned stream. `cells` gives the
/// notebook's code cells as they are now, as (URI, source). Closing the stream disconnects the
/// debugger, which leaves the kernel and its state running.
pub fn dap_stream(
    debugger: KernelDebugger,
    cells: impl Fn() -> Vec<(String, String)> + Send + 'static,
) -> DuplexStream {
    let (ide, ours) = tokio::io::duplex(1 << 16);
    tokio::spawn(bridge(debugger, cells, ours));
    ide
}

/// What to do with a request of the IDE.
enum Next {
    Send(Value),
    /// Answered here, without the kernel.
    Reply(Value),
    /// The cell's current code must be dumped first; the request waits.
    Dump {
        uri: String,
        code: String,
        request: Value,
    },
}

async fn bridge(mut debugger: KernelDebugger, cells: impl Fn() -> Vec<(String, String)>, stream: DuplexStream) {
    let (read, mut write) = tokio::io::split(stream);
    let (requests, mut from_ide) = mpsc::channel::<Value>(64);
    let reader = tokio::spawn(async move {
        let mut read = BufReader::new(read);
        while let Ok(Some(message)) = read_message(&mut read).await {
            if requests.send(message).await.is_err() {
                break;
            }
        }
    });
    let mut map = PathMap::default();
    // The bridge's dumpCell requests in flight, by seq; the IDE's requests wait for them.
    let mut dumping: HashMap<i64, (String, String)> = HashMap::new();
    let mut held: VecDeque<Value> = VecDeque::new();
    let mut seq = OWN_SEQ;
    let mut disconnected = false;
    // The IDE's requests the kernel has not answered yet, in order: the control channel
    // answers them in turn, and a kernel without debugpy answers with no message at all.
    let mut unanswered: VecDeque<(Value, Value)> = VecDeque::new();
    'session: loop {
        // The IDE's requests that wait for no dump, in order.
        while dumping.is_empty()
            && let Some(request) = held.pop_front()
        {
            match prepare(request, &map, &cells) {
                Next::Send(request) => {
                    unanswered.push_back((request["seq"].clone(), request["command"].clone()));
                    if debugger.send(request).await.is_err() {
                        break 'session;
                    }
                }
                Next::Reply(reply) => {
                    if write_message(&mut write, &reply).await.is_err() {
                        break 'session;
                    }
                }
                Next::Dump { uri, code, request } => {
                    seq += 1;
                    let dump =
                        json!({"type": "request", "seq": seq, "command": "dumpCell", "arguments": {"code": code}});
                    dumping.insert(seq, (uri, code));
                    held.push_front(request);
                    if debugger.send(dump).await.is_err() {
                        break 'session;
                    }
                }
            }
        }
        tokio::select! {
            request = from_ide.recv() => {
                let Some(mut request) = request else { break };
                // Never end the kernel: it is the notebook's, not the debug session's.
                if request["command"] == "terminate" {
                    let reply = json!({"type": "response", "request_seq": request["seq"], "command": "terminate", "success": true});
                    if write_message(&mut write, &reply).await.is_err() {
                        break;
                    }
                    continue;
                }
                if request["command"] == "disconnect" {
                    disconnected = true;
                    request["arguments"]["terminateDebuggee"] = json!(false);
                }
                held.push_back(request);
            }
            message = debugger.receive() => {
                let Some(mut message) = message else { break };
                if message["type"] == "response"
                    && let Some((uri, code)) = message["request_seq"].as_i64().and_then(|seq| dumping.remove(&seq))
                {
                    if let Some(path) = message["body"]["sourcePath"].as_str() {
                        map.insert(uri, code, path.to_owned());
                    }
                    continue;
                }
                if message.get("type").is_none() {
                    let Some((seq, command)) = unanswered.pop_front() else { continue };
                    message = json!({"type": "response", "request_seq": seq, "command": command,
                        "success": false, "message": CANNOT_DEBUG});
                } else if message["type"] == "response" {
                    unanswered.retain(|(seq, _)| *seq != message["request_seq"]);
                }
                // The kernel starts its debugger on `initialize`: then the cells can be dumped.
                let initialize = message["type"] == "response" && message["command"] == "initialize";
                let started = initialize && message["success"] == true;
                if initialize && !started && message.get("message").is_none() {
                    message["message"] = json!(NOT_STARTED);
                }
                map.to_ide(&mut message);
                if write_message(&mut write, &message).await.is_err() {
                    break;
                }
                if started {
                    for (uri, code) in cells() {
                        seq += 1;
                        let dump = json!({"type": "request", "seq": seq, "command": "dumpCell", "arguments": {"code": code}});
                        dumping.insert(seq, (uri, code));
                        let _ = debugger.send(dump).await;
                    }
                }
            }
        }
    }
    reader.abort();
    // Breakpoints left behind would stop later runs with no one to continue them.
    if !disconnected {
        let disconnect = json!({"type": "request", "seq": seq + 1, "command": "disconnect",
            "arguments": {"restart": false, "terminateDebuggee": false}});
        let _ = debugger.send(disconnect).await;
    }
}

/// A cell's breakpoints go to the file of the cell's current code, dumped again when the code
/// changed (or the cell is new) since the last dump.
fn prepare(mut request: Value, map: &PathMap, cells: &impl Fn() -> Vec<(String, String)>) -> Next {
    let uri = request["arguments"]["source"]["path"].as_str().filter(|path| path.starts_with(CELL_SCHEME));
    if request["command"] != "setBreakpoints" || uri.is_none() {
        map.to_kernel(&mut request);
        return Next::Send(request);
    }
    let uri = uri.unwrap_or_default().to_owned();
    let Some(code) = cells().into_iter().find(|(cell, _)| *cell == uri).map(|(_, code)| code) else {
        return Next::Reply(unverified(&request, "not a code cell of this notebook"));
    };
    match map.cells.get(&uri) {
        Some((dumped, path)) if *dumped == code => {
            if map.files.get(path) != Some(&uri) {
                return Next::Reply(unverified(&request, "another cell has the same code: set the breakpoint there"));
            }
            map.to_kernel(&mut request);
            Next::Send(request)
        }
        _ => Next::Dump { uri, code, request },
    }
}

/// A `setBreakpoints` response with each of `request`'s breakpoints unverified for `reason`.
fn unverified(request: &Value, reason: &str) -> Value {
    let breakpoints: Vec<Value> = request["arguments"]["breakpoints"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|breakpoint| json!({"verified": false, "line": breakpoint["line"], "message": reason}))
        .collect();
    json!({"type": "response", "request_seq": request["seq"], "command": request["command"], "success": true,
        "body": {"breakpoints": breakpoints}})
}

const CELL_SCHEME: &str = "vscode-notebook-cell:";

/// Cell URIs and the kernel's files for their code. Cells with the same code share a file;
/// it maps back to the first of them.
#[derive(Default)]
struct PathMap {
    /// By cell URI: the code dumped and its file.
    cells: HashMap<String, (String, String)>,
    /// By file: its cell.
    files: HashMap<String, String>,
}

impl PathMap {
    fn insert(&mut self, uri: String, code: String, path: String) {
        if let Some((_, old)) = self.cells.get(&uri)
            && self.files.get(old) == Some(&uri)
        {
            self.files.remove(&old.clone());
        }
        self.files.entry(path.clone()).or_insert_with(|| uri.clone());
        self.cells.insert(uri, (code, path));
    }

    fn to_kernel(&self, message: &mut Value) {
        rewrite(message, &|path| self.cells.get(path).map(|(_, file)| file.clone()));
    }

    fn to_ide(&self, message: &mut Value) {
        rewrite(message, &|path| self.files.get(path).cloned());
    }
}

/// Rewrites the `path` of every `source` object in `value`.
fn rewrite(value: &mut Value, paths: &dyn Fn(&str) -> Option<String>) {
    match value {
        Value::Object(object) => {
            if let Some(Value::Object(source)) = object.get_mut("source")
                && let Some(mapped) = source.get("path").and_then(Value::as_str).and_then(paths)
            {
                source.insert("path".into(), Value::String(mapped));
                // The kernel's name is its file's (`908337371.py`); the IDE names the cell.
                source.remove("name");
            }
            object.values_mut().for_each(|value| rewrite(value, paths));
        }
        Value::Array(values) => values.iter_mut().for_each(|value| rewrite(value, paths)),
        _ => {}
    }
}

async fn read_message<R: AsyncReadExt + AsyncBufReadExt + Unpin>(read: &mut R) -> std::io::Result<Option<Value>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if read.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length.filter(|length| *length <= MAX_MESSAGE_BYTES).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "DAP message without a valid Content-Length")
    })?;
    let mut body = vec![0; length];
    read.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map(Some).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

async fn write_message<W: AsyncWriteExt + Unpin>(write: &mut W, message: &Value) -> std::io::Result<()> {
    let body = message.to_string();
    write.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await?;
    write.write_all(body.as_bytes()).await?;
    write.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_rewritten_in_every_source() {
        let mut map = PathMap::default();
        map.insert("vscode-notebook-cell:/p/a.ipynb#c1".into(), "x = 1".into(), "/tmp/ipykernel_1/123.py".into());
        let mut request = json!({"command": "setBreakpoints", "arguments": {
            "source": {"path": "vscode-notebook-cell:/p/a.ipynb#c1", "name": "a.ipynb#c1"}, "breakpoints": [{"line": 2}]}});
        map.to_kernel(&mut request);
        assert_eq!(request["arguments"]["source"], json!({"path": "/tmp/ipykernel_1/123.py"}));
        let mut frames = json!({"body": {"stackFrames": [
            {"name": "f", "line": 2, "source": {"path": "/tmp/ipykernel_1/123.py", "name": "123.py"}},
            {"name": "g", "line": 9, "source": {"path": "/work/lib.py", "name": "lib.py"}}]}});
        map.to_ide(&mut frames);
        assert_eq!(frames["body"]["stackFrames"][0]["source"], json!({"path": "vscode-notebook-cell:/p/a.ipynb#c1"}));
        assert_eq!(frames["body"]["stackFrames"][1]["source"]["path"], "/work/lib.py", "other files are left alone");
    }

    /// A bridge over a stand-in kernel: what it is sent, and a way to answer.
    fn fake(
        cells: Vec<(String, String)>,
    ) -> (DuplexStream, mpsc::Receiver<jupyter_protocol::JupyterMessage>, mpsc::UnboundedSender<Value>) {
        let (control, sent) = mpsc::channel(16);
        let (answer, inbox) = mpsc::unbounded_channel();
        (dap_stream(KernelDebugger { control, inbox }, move || cells.clone()), sent, answer)
    }

    fn content(message: jupyter_protocol::JupyterMessage) -> Value {
        match message.content {
            jupyter_protocol::JupyterMessageContent::DebugRequest(request) => request.content,
            other => panic!("not a debug request: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_kernel_without_debugpy_fails_initialize_with_a_reason() {
        let (stream, mut sent, answer) = fake(Vec::new());
        let (read, mut write) = tokio::io::split(stream);
        let mut read = BufReader::new(read);
        write_message(&mut write, &json!({"type": "request", "seq": 1, "command": "initialize", "arguments": {}}))
            .await
            .unwrap();
        assert_eq!(content(sent.recv().await.unwrap())["command"], "initialize");
        answer.send(Value::Null).unwrap();
        let reply = read_message(&mut read).await.unwrap().unwrap();
        assert_eq!(reply["request_seq"], 1);
        assert_eq!(reply["success"], false);
        assert_eq!(reply["message"], CANNOT_DEBUG);
    }

    #[tokio::test]
    async fn breakpoints_wait_for_the_cells_to_be_dumped() {
        let uri = "vscode-notebook-cell:/p/a.ipynb#c1";
        let (stream, mut sent, answer) = fake(vec![(uri.into(), "x = 1\n".into())]);
        let (read, mut write) = tokio::io::split(stream);
        let mut read = BufReader::new(read);
        write_message(&mut write, &json!({"type": "request", "seq": 1, "command": "initialize", "arguments": {}}))
            .await
            .unwrap();
        sent.recv().await.unwrap();
        answer.send(json!({"type": "response", "request_seq": 1, "command": "initialize", "success": true})).unwrap();
        assert_eq!(read_message(&mut read).await.unwrap().unwrap()["success"], true);
        let dump = content(sent.recv().await.unwrap());
        assert_eq!((dump["command"].as_str(), dump["arguments"]["code"].as_str()), (Some("dumpCell"), Some("x = 1\n")));
        // Sent before the dump is answered: held, then sent with the kernel's path.
        let set = json!({"type": "request", "seq": 2, "command": "setBreakpoints",
            "arguments": {"source": {"path": uri}, "breakpoints": [{"line": 1}]}});
        write_message(&mut write, &set).await.unwrap();
        tokio::task::yield_now().await;
        assert!(sent.try_recv().is_err());
        answer
            .send(json!({"type": "response", "request_seq": dump["seq"], "command": "dumpCell", "success": true,
            "body": {"sourcePath": "/tmp/k/1.py"}}))
            .unwrap();
        let set = content(sent.recv().await.unwrap());
        assert_eq!(set["arguments"]["source"]["path"], "/tmp/k/1.py");
        // Dropping the IDE's side disconnects the kernel's debugger.
        drop((read, write));
        let disconnect = content(sent.recv().await.unwrap());
        assert_eq!(
            (disconnect["command"].as_str(), disconnect["arguments"]["terminateDebuggee"].as_bool()),
            (Some("disconnect"), Some(false))
        );
    }

    /// Starts a bridge over `cells` and answers `initialize` and the first dumps (`/tmp/k/<n>.py`).
    async fn started(
        cells: std::sync::Arc<parking_lot::Mutex<Vec<(String, String)>>>,
    ) -> (
        BufReader<tokio::io::ReadHalf<DuplexStream>>,
        tokio::io::WriteHalf<DuplexStream>,
        mpsc::Receiver<jupyter_protocol::JupyterMessage>,
        mpsc::UnboundedSender<Value>,
    ) {
        let (control, mut sent) = mpsc::channel(16);
        let (answer, inbox) = mpsc::unbounded_channel();
        let current = cells.clone();
        let stream = dap_stream(KernelDebugger { control, inbox }, move || current.lock().clone());
        let (read, mut write) = tokio::io::split(stream);
        let mut read = BufReader::new(read);
        write_message(&mut write, &json!({"type": "request", "seq": 1, "command": "initialize", "arguments": {}}))
            .await
            .unwrap();
        sent.recv().await.unwrap();
        answer.send(json!({"type": "response", "request_seq": 1, "command": "initialize", "success": true})).unwrap();
        read_message(&mut read).await.unwrap().unwrap();
        let count = cells.lock().len();
        for _ in 0..count {
            answer_dump(&mut sent, &answer).await;
        }
        (read, write, sent, answer)
    }

    /// Answers the next request, a dumpCell, with a file named by its code's length.
    async fn answer_dump(
        sent: &mut mpsc::Receiver<jupyter_protocol::JupyterMessage>,
        answer: &mpsc::UnboundedSender<Value>,
    ) {
        let dump = content(sent.recv().await.unwrap());
        assert_eq!(dump["command"], "dumpCell");
        let path = format!("/tmp/k/{}.py", dump["arguments"]["code"].as_str().unwrap().len());
        answer
            .send(json!({"type": "response", "request_seq": dump["seq"], "command": "dumpCell", "success": true,
            "body": {"sourcePath": path}}))
            .unwrap();
    }

    fn set(seq: i64, uri: &str) -> Value {
        json!({"type": "request", "seq": seq, "command": "setBreakpoints",
            "arguments": {"source": {"path": uri}, "breakpoints": [{"line": 1}]}})
    }

    #[tokio::test]
    async fn cells_edited_or_added_during_the_session_are_dumped_again() {
        let (a, b) = ("vscode-notebook-cell:/p/a.ipynb#a", "vscode-notebook-cell:/p/a.ipynb#b");
        let cells = std::sync::Arc::new(parking_lot::Mutex::new(vec![(a.to_owned(), "x = 1".to_owned())]));
        let (_read, mut write, mut sent, answer) = started(cells.clone()).await;
        // Unchanged: straight to the kernel.
        write_message(&mut write, &set(2, a)).await.unwrap();
        assert_eq!(content(sent.recv().await.unwrap())["arguments"]["source"]["path"], "/tmp/k/5.py");
        // Edited, and a new cell: dumped again first.
        cells.lock()[0].1 = "x = 100".into();
        cells.lock().push((b.to_owned(), "y".to_owned()));
        write_message(&mut write, &set(3, a)).await.unwrap();
        answer_dump(&mut sent, &answer).await;
        assert_eq!(content(sent.recv().await.unwrap())["arguments"]["source"]["path"], "/tmp/k/7.py");
        write_message(&mut write, &set(4, b)).await.unwrap();
        answer_dump(&mut sent, &answer).await;
        assert_eq!(content(sent.recv().await.unwrap())["arguments"]["source"]["path"], "/tmp/k/1.py");
    }

    #[tokio::test]
    async fn a_cell_with_another_cells_code_says_so() {
        let (a, b, gone) = (
            "vscode-notebook-cell:/p/a.ipynb#a",
            "vscode-notebook-cell:/p/a.ipynb#b",
            "vscode-notebook-cell:/p/a.ipynb#gone",
        );
        let cells = std::sync::Arc::new(parking_lot::Mutex::new(vec![
            (a.to_owned(), "x = 1".to_owned()),
            (b.to_owned(), "x = 1".to_owned()),
        ]));
        let (mut read, mut write, mut sent, _answer) = started(cells).await;
        write_message(&mut write, &set(2, b)).await.unwrap();
        let reply = read_message(&mut read).await.unwrap().unwrap();
        assert_eq!(reply["request_seq"], 2);
        assert_eq!(reply["body"]["breakpoints"][0]["verified"], false);
        assert!(reply["body"]["breakpoints"][0]["message"].as_str().unwrap().contains("same code"));
        write_message(&mut write, &set(3, gone)).await.unwrap();
        let reply = read_message(&mut read).await.unwrap().unwrap();
        assert_eq!(
            (reply["request_seq"].as_i64(), reply["body"]["breakpoints"][0]["verified"].as_bool()),
            (Some(3), Some(false))
        );
        // The first of the two keeps the file.
        write_message(&mut write, &set(4, a)).await.unwrap();
        assert_eq!(content(sent.recv().await.unwrap())["arguments"]["source"]["path"], "/tmp/k/5.py");
    }

    #[tokio::test]
    async fn dap_frames_round_trip() {
        let (a, b) = tokio::io::duplex(1024);
        let (_, mut write) = tokio::io::split(a);
        let (read, _) = tokio::io::split(b);
        let mut read = BufReader::new(read);
        write_message(&mut write, &json!({"seq": 1, "type": "request", "command": "initialize"})).await.unwrap();
        write_message(&mut write, &json!({"seq": 2, "text": "ünïcode"})).await.unwrap();
        assert_eq!(read_message(&mut read).await.unwrap().unwrap()["command"], "initialize");
        assert_eq!(read_message(&mut read).await.unwrap().unwrap()["text"], "ünïcode");
    }
}
