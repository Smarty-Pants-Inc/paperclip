// Keep: real PRP authentication and exclusive listener admission under the server's
// actual pattern of abandoned 15-second controller upgrade attempts.
struct AbandonedFloodPeer {
    commands: mpsc::Sender<Option<u64>>,
    upgraded: mpsc::Receiver<Result<(), String>>,
    worker: thread::JoinHandle<Result<(), String>>,
}

fn abandoned_flood_peer(address: SocketAddr, name: &'static str) -> AbandonedFloodPeer {
    let cfg = config(address.port());
    let state = test_state(&cfg);
    let (commands, receive) = mpsc::channel();
    let (report, upgraded) = mpsc::channel();
    let worker = thread::spawn(move || {
        let stream = TcpStream::connect(address).map_err(|error| error.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(18)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut socket = match client(
            format!("ws://{address}/api/runner/v1/connect/run_1"),
            stream,
        ) {
            Ok((socket, _)) => {
                let _ = report.send(Ok(()));
                socket
            }
            Err(error) => {
                let message = format!("{name} upgrade: {error}");
                let _ = report.send(Err(message.clone()));
                return Err(message);
            }
        };
        let expires = current_unix_ms().unwrap() + 60_000;
        let mut channel = server_authenticate(
            &mut socket,
            &cfg,
            &state,
            ServerCredential {
                token: "abandoned-flood-test",
                kind: "bootstrap",
                lease_id: None,
                expires_at_unix_ms: expires,
                revocation_epoch: 0,
            },
        );
        send_secure(
            &mut socket,
            &mut channel,
            &cfg,
            &welcome(&state, name, Some("flood-test-lease"), expires, 0, vec![]),
        );
        send_secure(
            &mut socket,
            &mut channel,
            &cfg,
            &json!({"peer": name, "tick": 0}),
        );
        while let Ok(Some(tick)) = receive.recv_timeout(Duration::from_secs(20)) {
            send_secure(
                &mut socket,
                &mut channel,
                &cfg,
                &json!({"peer": name, "tick": tick}),
            );
        }
        Ok(())
    });
    AbandonedFloodPeer {
        commands,
        upgraded,
        worker,
    }
}

fn abandoned_upgrade_flood(address: SocketAddr, path: &str) {
    for _ in 0..15 {
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
                )
                .as_bytes(),
            )
            .unwrap();
        // Let the listener consume the complete valid request and block waiting
        // for admission before matching the server's 15s client-side close.
        thread::sleep(Duration::from_millis(20));
        let _ = stream.shutdown(std::net::Shutdown::Both);
        drop(stream);
    }
    thread::sleep(Duration::from_millis(50));
}

fn abandoned_flood_auth(
    endpoint: &RunnerTransportEndpoint,
    address: SocketAddr,
    budget: Duration,
) -> AuthenticatedTransport {
    let cfg = config(address.port());
    let state = test_state(&cfg);
    let ticket = BootstrapTicket::new("abandoned-flood-test".to_owned()).unwrap();
    let deadline = Instant::now() + budget;
    loop {
        match AuthenticatedTransport::connect(endpoint, &cfg, &state, Some(&ticket), None, deadline) {
            Ok(Some((transport, _))) => return transport,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
            Ok(None) => panic!("no authenticated controller before deadline"),
            Err(error) => panic!("controller PRP authentication failed: {error}"),
        }
    }
}

fn abandoned_flood_trial(flood_after_b_waits: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let path = "/api/runner/v1/connect/run_1";
    let endpoint = RunnerTransportEndpoint::from_listener(listener, path.to_owned());
    let a = abandoned_flood_peer(address, "A");
    let mut active = abandoned_flood_auth(&endpoint, address, Duration::from_secs(3));
    assert_eq!(active.receive_json_until(Some(Instant::now() + Duration::from_secs(1))).unwrap().unwrap()["peer"], "A");
    a.upgraded.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();

    let b = abandoned_flood_peer(address, "B");
    if flood_after_b_waits {
        assert!(
            b.upgraded.recv_timeout(Duration::from_millis(100)).is_err(),
            "B must be waiting for A's admission"
        );
        abandoned_upgrade_flood(address, path);
    } else {
        abandoned_upgrade_flood(address, path);
        assert!(
            b.upgraded.recv_timeout(Duration::from_millis(100)).is_err(),
            "B must wait rather than be admitted while A is live"
        );
    }

    // Abandoned connections must not be published, and A remains the only live
    // controller while the legitimate B waits.
    for tick in 1..=3 {
        a.commands.send(Some(tick)).unwrap();
        assert_eq!(
            active.receive_json_until(Some(Instant::now() + Duration::from_secs(1))).unwrap().unwrap()["tick"],
            tick
        );
        assert!(endpoint.open(65536, None, Instant::now() + Duration::from_millis(100)).unwrap().is_none(),
            "an abandoned attempt or waiting B was published while A remained live");
    }

    let released = Instant::now();
    drop(active);
    let _ = a.commands.send(None);
    a.worker.join().unwrap().unwrap();

    let cfg = config(address.port());
    let state = test_state(&cfg);
    let ticket = BootstrapTicket::new("abandoned-flood-test".to_owned()).unwrap();
    let deadline = released + Duration::from_secs(2);
    let mut authenticated_b = loop {
        match AuthenticatedTransport::connect(
            &endpoint,
            &cfg,
            &state,
            Some(&ticket),
            None,
            deadline,
        ) {
            Ok(Some((transport, _))) => break transport,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
            Ok(None) => panic!("B was not admitted within 2s after A released admission"),
            Err(error) => panic!("B PRP authentication failed: {error}"),
        }
    };
    let b_frame = authenticated_b
        .receive_json_until(Some(Instant::now() + Duration::from_secs(1)))
        .unwrap()
        .expect("B encrypted PRP frame");
    assert_eq!(b_frame["peer"], "B", "an abandoned attempt won admission");
    assert!(released.elapsed() < Duration::from_secs(2), "B admission exceeded bound");
    b.upgraded
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    assert!(endpoint.open(65536, None, Instant::now() + Duration::from_millis(100)).unwrap().is_none(),
        "a second live controller was admitted alongside B");
    eprintln!(
        "abandoned flood after_b_waits={flood_after_b_waits} admitted_ms={} authenticated={}",
        released.elapsed().as_millis(),
        b_frame["peer"]
    );
    drop(authenticated_b);
    let _ = b.commands.send(None);
    b.worker.join().unwrap().unwrap();
}

#[test]
fn server_abandoned_upgrade_flood_before_legitimate_waiter() {
    for _ in 0..3 {
        abandoned_flood_trial(false);
    }
}

#[test]
fn server_abandoned_upgrade_flood_after_legitimate_waiter() {
    for _ in 0..3 {
        abandoned_flood_trial(true);
    }
}
