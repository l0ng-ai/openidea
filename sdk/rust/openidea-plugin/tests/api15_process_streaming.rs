use openidea_plugin::{
    ProcessOutput,
    host::{self, Command, ProcessOptions},
    mock::MockHost,
};

#[test]
fn process_captured_and_stream_apis_are_available_in_sdk() {
    let mock = MockHost::install().with_capabilities(&["process:git"]);
    mock.on_process("git", |_args, _stdin| {
        Ok(ProcessOutput { status: Some(0), stdout: "mock stdout".into(), stderr: String::new() })
    });

    let cmd = Command::new("git").arg("status");
    let options = ProcessOptions { max_output_bytes: Some(8 << 20), buffer_bytes: Some(64 << 10) };

    let out = host::run_captured(&cmd, None, None, Some(options)).unwrap();
    assert_eq!(out.status, Some(0));
    assert_eq!(out.stdout, "mock stdout");

    let child = host::start_stream(&cmd, None, Some(options)).unwrap();
    let chunk = child.poll(1024).unwrap();
    assert_eq!(chunk.stdout, "started: git\n");
    assert_eq!(chunk.status, None);

    let final_chunk = child.wait(100).unwrap();
    assert_eq!(final_chunk.status, Some(0));
}
