//! A stand-in phone for trying pairing without the mobile app:
//! `cargo run -p ide-pair --example phone -- '<pairing code>'` pairs with the desktop that
//! showed the code and stays connected; run it again without the code to reconnect.
//! The phone's key is kept in the system temporary directory.

use std::time::Duration;

#[tokio::main]
async fn main() {
    let key_file = std::env::temp_dir().join("openidea-example-phone.key");
    let addr_file = std::env::temp_dir().join("openidea-example-phone.desktop");
    let key = ide_pair::load_or_create_key(&key_file).expect("phone key");
    let (addr, code) = match std::env::args().nth(1) {
        Some(text) => {
            let ticket = ide_pair::Ticket::decode(&text).expect("an openidea-pair: code");
            std::fs::write(&addr_file, serde_json::to_vec(&ticket.addr).unwrap()).unwrap();
            (ticket.addr, Some(ticket.code))
        }
        None => {
            let saved = std::fs::read(&addr_file).expect("pair first: pass the pairing code");
            (serde_json::from_slice(&saved).unwrap(), None)
        }
    };
    let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0).secret_key(key).bind().await.expect("endpoint");
    println!("phone {}", endpoint.id());
    match ide_pair::connect(&endpoint, addr, "Example Phone", code.as_deref()).await {
        Ok((connection, welcome, _send, _recv)) => {
            println!("connected to {} — press Ctrl+C to disconnect", welcome.desktop);
            tokio::select! {
                _ = connection.closed() => println!("the desktop closed the connection"),
                _ = tokio::signal::ctrl_c() => {}
            }
        }
        Err(e) => eprintln!("{e}"),
    }
    endpoint.close().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
}
