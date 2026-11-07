//! `openidea-server --connect <host> <port>`: one forwarded connection. The desktop starts it
//! in a dev container (`docker exec -i`) for each connection to a forwarded port and pipes the
//! connection through stdin / stdout, so a port of the container is reachable wherever the
//! container's network is not.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// `<host> <port>` from the arguments after `--connect`.
pub fn parse_args(args: &[String]) -> Result<(String, u16), String> {
    let [host, port] = args else { return Err("usage: openidea-server --connect <host> <port>".into()) };
    if host.is_empty() || host.starts_with('-') || host.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(format!("invalid host {host:?}"));
    }
    match port.parse::<u16>() {
        Ok(p) if p != 0 => Ok((host.clone(), p)),
        _ => Err(format!("invalid port {port:?}")),
    }
}

/// Connects to `host:port`, copies `input` to it and its replies to `output`, and returns when
/// the target is done (the copy of `input` may still be blocked: the caller exits). Fails only
/// when the connection can't be opened.
pub fn relay(host: &str, port: u16, mut input: impl Read + Send + 'static, mut output: impl Write) -> io::Result<()> {
    let mut from_target = connect(host, port)?;
    let mut to_target = from_target.try_clone()?;
    std::thread::spawn(move || {
        let _ = io::copy(&mut input, &mut to_target);
        // The client closed its side: tell the target, which may still answer.
        let _ = to_target.shutdown(Shutdown::Write);
    });
    let mut buf = [0u8; 16 * 1024];
    loop {
        match from_target.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if output.write_all(&buf[..n]).and_then(|()| output.flush()).is_err() {
                    break;
                }
            }
        }
    }
    let _ = from_target.shutdown(Shutdown::Both);
    Ok(())
}

fn connect(host: &str, port: u16) -> io::Result<TcpStream> {
    use std::net::ToSocketAddrs;
    let mut last = io::Error::new(io::ErrorKind::NotFound, format!("{host} has no address"));
    for addr in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn reads_host_and_port() {
        assert_eq!(parse_args(&args(&["localhost", "8000"])).unwrap(), ("localhost".into(), 8000));
        for bad in [&["localhost"][..], &["localhost", "0"], &["localhost", "70000"], &["-x", "80"], &["a b", "80"]] {
            assert!(parse_args(&args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn pipes_a_request_and_its_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut request = String::new();
            s.read_to_string(&mut request).unwrap();
            s.write_all(format!("got {request}").as_bytes()).unwrap();
        });
        let mut out = Vec::new();
        relay("127.0.0.1", port, &b"ping"[..], &mut out).unwrap();
        server.join().unwrap();
        assert_eq!(out, b"got ping");
    }

    #[test]
    fn a_closed_port_is_an_error() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(relay("127.0.0.1", port, io::empty(), io::sink()).is_err());
    }
}
