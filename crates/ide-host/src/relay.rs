//! `openidea-server --connect <host> <port>`: one forwarded connection. The desktop starts it
//! in a dev container (`docker exec -i`) for each connection to a forwarded port and pipes the
//! connection through stdin / stdout, so a port of the container is reachable wherever the
//! container's network is not.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const EOF_GRACE: Duration = Duration::from_secs(5);

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
/// when the connection can't be opened. An input EOF allows five idle seconds for a final reply.
pub fn relay(host: &str, port: u16, mut input: impl Read + Send + 'static, mut output: impl Write) -> io::Result<()> {
    let mut from_target = connect(host, port)?;
    from_target.set_read_timeout(Some(Duration::from_millis(100)))?;
    let mut to_target = from_target.try_clone()?;
    let writing = Arc::new(Mutex::new(None::<Instant>));
    let stalled = writing.clone();
    let (finished, eof) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0; 16 * 1024];
        loop {
            let n = match input.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            *writing.lock().unwrap() = Some(Instant::now());
            let result = to_target.write_all(&buf[..n]);
            *writing.lock().unwrap() = None;
            if result.is_err() {
                break;
            }
        }
        // The client closed its side: tell the target, which may still answer.
        let _ = to_target.shutdown(Shutdown::Write);
        let _ = finished.send(Instant::now());
    });
    let mut buf = [0u8; 16 * 1024];
    let mut input_closed = None;
    loop {
        // A blocked write must not hide Docker closing stdin indefinitely.
        if stalled.lock().unwrap().is_some_and(|at| at.elapsed() >= CONNECT_TIMEOUT) {
            break;
        }
        if let Ok(at) = eof.try_recv() {
            input_closed = Some(at);
        }
        // Docker closing stdin must end an idle relay too. Keep a bounded grace for
        // a target replying to a half-closed request before tearing down the socket.
        if input_closed.is_some_and(|at| at.elapsed() >= EOF_GRACE) {
            break;
        }
        match from_target.read(&mut buf) {
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => continue,
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if output.write_all(&buf[..n]).and_then(|()| output.flush()).is_err() {
                    break;
                }
                if input_closed.is_some() {
                    input_closed = Some(Instant::now());
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
    fn input_eof_ends_a_relay_even_when_the_target_ignores_it() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (done, wait) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            socket.read_to_end(&mut request).unwrap();
            // Remain open after seeing EOF, like an idle keep-alive server.
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
        });
        let start = Instant::now();
        relay("127.0.0.1", port, io::empty(), io::sink()).unwrap();
        assert!(start.elapsed() < Duration::from_secs(8));
        done.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn final_responses_keep_flowing_after_input_eof() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.read_to_end(&mut Vec::new()).unwrap();
            for _ in 0..7 {
                socket.write_all(b"x").unwrap();
                std::thread::sleep(Duration::from_secs(1));
            }
        });
        let mut out = Vec::new();
        relay("127.0.0.1", port, io::empty(), &mut out).unwrap();
        assert_eq!(out, b"xxxxxxx");
        server.join().unwrap();
    }

    #[test]
    fn a_target_that_never_reads_cannot_keep_a_relay_alive() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (done, wait) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            wait.recv_timeout(Duration::from_secs(30)).unwrap();
        });
        let start = Instant::now();
        relay("127.0.0.1", port, io::repeat(0).take(32 * 1024 * 1024), io::sink()).unwrap();
        assert!(start.elapsed() < Duration::from_secs(25));
        done.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn a_closed_port_is_an_error() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(relay("127.0.0.1", port, io::empty(), io::sink()).is_err());
    }
}
