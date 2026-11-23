use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

async fn endpoint(alpns: Vec<Vec<u8>>) -> Endpoint {
    bind_local(!alpns.is_empty()).await
}

struct Desktop {
    listener: Listener,
    changes: Arc<AtomicUsize>,
    _dir: tempfile::TempDir,
}

/// A desktop whose sessions echo what the phone sends.
async fn desktop() -> Desktop {
    let dir = tempfile::tempdir().unwrap();
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = changes.clone();
    let handler: SessionHandler = Arc::new(|mut s: Session| {
        Box::pin(async move {
            let _ = tokio::io::copy(&mut s.recv, &mut s.send).await;
            let _ = s.send.finish();
            s.connection.closed().await;
        })
    });
    let listener = Listener::start(
        endpoint(vec![ALPN.to_vec()]).await,
        DeviceStore::load(dir.path().join("devices.json")),
        "Workstation".into(),
        handler,
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
    );
    Desktop { listener, changes, _dir: dir }
}

async fn echo(send: &mut SendStream, recv: &mut RecvStream) -> Vec<u8> {
    send.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    recv.read_exact(&mut buf).await.unwrap();
    buf.to_vec()
}

#[test]
fn a_ticket_round_trips_through_its_text() {
    let key = SecretKey::generate();
    let ticket =
        Ticket { v: 1, desktop: "Workstation".into(), addr: EndpointAddr::new(key.public()), code: "abc".into() };
    let text = ticket.encode();
    assert!(text.starts_with(TICKET_PREFIX));
    assert_eq!(Ticket::decode(&text).unwrap(), ticket);
    assert!(matches!(Ticket::decode("https://example.com"), Err(PairError::Ticket)));
    assert!(matches!(Ticket::decode("openidea-pair:!!"), Err(PairError::Ticket)));
}

#[test]
fn the_endpoint_key_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("mobile").join("endpoint.key");
    let first = load_or_create_key(&file).unwrap();
    assert_eq!(load_or_create_key(&file).unwrap().public(), first.public());
}

#[tokio::test]
async fn a_phone_pairs_with_the_code_once_and_then_reconnects_without_it() {
    let desktop = desktop().await;
    let ticket = desktop.listener.ticket(Duration::from_secs(60)).await.0;

    let phone = endpoint(vec![]).await;
    let (conn, welcome, mut send, mut recv) =
        connect(&phone, ticket.addr.clone(), "Pixel", Some(&ticket.code)).await.unwrap();
    assert_eq!(welcome.desktop, "Workstation");
    assert_eq!(echo(&mut send, &mut recv).await, b"ping");
    let devices = desktop.listener.devices();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].0.name, "Pixel");
    assert_eq!(devices[0].0.id, phone.id().to_string());
    assert!(devices[0].1, "shown as connected");
    conn.close(0u32.into(), b"bye");

    // The code is used up: another phone can't pair with it.
    let stranger = endpoint(vec![]).await;
    let refused = connect(&stranger, ticket.addr.clone(), "Stranger", Some(&ticket.code)).await;
    assert!(matches!(refused, Err(PairError::Refused(_))), "{refused:?}");

    // The paired phone needs no code.
    let (_conn, _, mut send, mut recv) = connect(&phone, ticket.addr.clone(), "Pixel", None).await.unwrap();
    assert_eq!(echo(&mut send, &mut recv).await, b"ping");
    assert!(desktop.changes.load(Ordering::SeqCst) >= 2);
}

#[tokio::test]
async fn an_unpaired_phone_without_a_code_is_refused() {
    let desktop = desktop().await;
    let ticket = desktop.listener.ticket(Duration::from_secs(60)).await.0;
    let phone = endpoint(vec![]).await;
    let refused = connect(&phone, ticket.addr, "Pixel", None).await;
    assert!(matches!(&refused, Err(PairError::Refused(e)) if e.contains("not paired")), "{refused:?}");
    assert!(desktop.listener.devices().is_empty());
}

#[tokio::test]
async fn an_expired_or_cancelled_code_does_not_pair() {
    let desktop = desktop().await;
    let expired = desktop.listener.ticket(Duration::ZERO).await.0;
    let phone = endpoint(vec![]).await;
    assert!(connect(&phone, expired.addr.clone(), "Pixel", Some(&expired.code)).await.is_err());

    let cancelled = desktop.listener.ticket(Duration::from_secs(60)).await.0;
    desktop.listener.cancel_pairing();
    assert!(connect(&phone, cancelled.addr, "Pixel", Some(&cancelled.code)).await.is_err());
    assert!(desktop.listener.devices().is_empty());
}

#[tokio::test]
async fn removing_a_device_drops_its_connection_and_its_pairing() {
    let desktop = desktop().await;
    let ticket = desktop.listener.ticket(Duration::from_secs(60)).await.0;
    let phone = endpoint(vec![]).await;
    let (conn, ..) = connect(&phone, ticket.addr.clone(), "Pixel", Some(&ticket.code)).await.unwrap();

    assert!(desktop.listener.remove(&phone.id().to_string()).unwrap());
    tokio::time::timeout(Duration::from_secs(5), conn.closed()).await.expect("connection closed");
    assert!(desktop.listener.devices().is_empty());
    assert!(connect(&phone, ticket.addr, "Pixel", None).await.is_err());
}

#[tokio::test]
async fn asking_again_while_the_code_works_gives_the_same_code() {
    let desktop = desktop().await;
    let (first, _) = desktop.listener.ticket(Duration::from_secs(60)).await;
    let (second, left) = desktop.listener.ticket(Duration::from_secs(60)).await;
    assert_eq!(first.code, second.code);
    assert!(left <= Duration::from_secs(60));
    desktop.listener.cancel_pairing();
    assert_ne!(desktop.listener.ticket(Duration::from_secs(60)).await.0.code, first.code);
}
