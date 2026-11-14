// Keep: real mutual-authentication boundary and the M1 Pi hire ingress regression.
fn listener_waiter_handover(close_after: Duration) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let path = "/api/runner/v1/connect/run_1".to_owned();
    let endpoint = RunnerTransportEndpoint::from_listener(listener, path.clone());
    let config = config(address.port());
    let state = test_state(&config);
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let connect = || {
        let deadline = Instant::now() + Duration::from_secs(18);
        loop {
            match AuthenticatedTransport::connect(
                &endpoint,
                &config,
                &state,
                Some(&ticket),
                None,
                deadline,
            ) {
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
                result => break result,
            }
        }
    };
    let spawn_peer = |number: usize| {
        let path = path.clone();
        let config = config.clone();
        let state = state.clone();
        let (release, held) = mpsc::channel();
        let (upgraded, upgrade_received) = mpsc::channel();
        let worker = thread::spawn(move || {
            let stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(18)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(18)))
                .unwrap();
            let result = client(format!("ws://{address}{path}"), stream);
            let _ = upgraded.send(result.is_ok());
            let (mut socket, _) =
                result.map_err(|error| format!("controller {number} upgrade: {error}"))?;
            let expires = current_unix_ms().unwrap() + 60_000;
            let mut secure = server_authenticate(
                &mut socket,
                &config,
                &state,
                ServerCredential {
                    token: "bootstrap-secret",
                    kind: "bootstrap",
                    lease_id: None,
                    expires_at_unix_ms: expires,
                    revocation_epoch: 0,
                },
            );
            send_secure(
                &mut socket,
                &mut secure,
                &config,
                &welcome(
                    &state,
                    &format!("connection_{number}"),
                    Some("lease-secret"),
                    expires,
                    0,
                    vec![],
                ),
            );
            send_secure(
                &mut socket,
                &mut secure,
                &config,
                &json!({"controller": number}),
            );
            let _ = held.recv_timeout(Duration::from_secs(18));
            Ok::<_, String>(())
        });
        (release, upgrade_received, worker)
    };
    let (release_a, upgraded_a, peer_a) = spawn_peer(1);
    let (mut controller_a, _) = connect().unwrap().expect("A must authenticate");
    assert!(upgraded_a.recv().unwrap());
    assert_eq!(
        controller_a
            .receive_json_until(Some(Instant::now() + Duration::from_secs(1)))
            .unwrap()
            .unwrap()["controller"],
        1
    );
    let started = Instant::now();
    let (release_b, upgraded_b, peer_b) = spawn_peer(2);
    // HTTP upgrade must remain pending, not succeed or reject while A is live.
    let early_upgrade = upgraded_b.recv_timeout(close_after);
    // Keep A's lifetime identical on RED too: an early rejection must not
    // accidentally turn the seeded case into an immediate controller close.
    thread::sleep(close_after.saturating_sub(started.elapsed()));
    let overlap = endpoint
        .open(
            config.max_frame_bytes,
            None,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    drop(controller_a);
    let _ = release_a.send(());
    let a_result = peer_a.join().unwrap();
    let b_result = if early_upgrade.is_err() {
        connect()
    } else {
        Ok(None)
    };
    if let Ok(Some((mut transport, _))) = b_result {
        assert_eq!(
            transport
                .receive_json_until(Some(Instant::now() + Duration::from_secs(1)))
                .unwrap()
                .unwrap()["controller"],
            2
        );
        eprintln!(
            "queued handover: A_close_ms={} B_authenticated_ms={}",
            close_after.as_millis(),
            started.elapsed().as_millis()
        );
    } else {
        let _ = release_b.send(());
        let peer_result = peer_b.join().unwrap();
        panic!("B must wait and authenticate after A closes: early={early_upgrade:?}, peer={peer_result:?}");
    }
    let _ = release_b.send(());
    let peer_result = peer_b.join().unwrap();
    a_result.unwrap();
    peer_result.unwrap();
    assert!(
        early_upgrade.is_err(),
        "B completed HTTP upgrade while A was live"
    );
    assert!(
        overlap.is_none(),
        "two runner controller sockets were delivered"
    );
    assert!(started.elapsed() < Duration::from_secs(15));
}

fn listener_waiter_cancellation(rotate: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let path = "/api/runner/v1/connect/run_1".to_owned();
    let mut endpoint = RunnerTransportEndpoint::from_listener(listener, path.clone());
    let start_client = |path: String| {
        let (result, received) = mpsc::channel();
        let worker = thread::spawn(move || {
            let stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(18)))
                .unwrap();
            let connection = client(format!("ws://{address}{path}"), stream);
            result.send(connection).unwrap();
        });
        (received, worker)
    };
    let take = |endpoint: &RunnerTransportEndpoint| {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(socket) = endpoint.open(1024 * 1024, None, deadline).unwrap() {
                break socket;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
    };
    let (first, first_worker) = start_client(path.clone());
    let mut controller = take(&endpoint);
    let first_peer = first.recv().unwrap().unwrap().0;
    first_worker.join().unwrap();
    let RunnerSocket::Listen(socket) = &mut controller else {
        unreachable!()
    };
    socket.authenticated().unwrap();
    let (second, worker) = start_client(path);
    let pending = second.recv_timeout(Duration::from_millis(100));
    let started = Instant::now();
    if rotate {
        let next = "/api/runner/v1/connect/run_2";
        // from_listener binds loopback, whereas public rotate requires wildcard;
        // use the internal ingress rotation called by that public method.
        if let RunnerTransportEndpoint::Listen { listener, path } = &mut endpoint {
            *path = next.to_owned();
            listener.rotate(path.clone());
        }
    } else {
        drop(endpoint);
    }
    let refused = second.recv_timeout(Duration::from_secs(1));
    worker.join().unwrap();
    assert!(pending.is_err(), "second upgrade did not wait");
    assert!(
        matches!(refused, Ok(Err(_))),
        "cancelled waiter must close or reject"
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(controller);
    drop(first_peer);
}

#[test]
fn disconnected_waiter_does_not_claim_released_admission() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let path = "/api/runner/v1/connect/run_1";
    let endpoint = RunnerTransportEndpoint::from_listener(listener, path.to_owned());

    let (a_peer, _) = client(
        format!("ws://{address}{path}"),
        TcpStream::connect(address).unwrap(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut controller_a = loop {
        if let Some(socket) = endpoint.open(65536, None, deadline).unwrap() {
            break socket;
        }
        assert!(Instant::now() < deadline, "A was not admitted");
        thread::sleep(Duration::from_millis(1));
    };
    let RunnerSocket::Listen(socket) = &mut controller_a else {
        unreachable!()
    };
    socket.authenticated().unwrap();

    let mut abandoned = TcpStream::connect(address).unwrap();
    abandoned
        .write_all(
            format!(
                "GET {path} HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    let _ = abandoned.shutdown(std::net::Shutdown::Both);
    drop(abandoned);
    thread::sleep(Duration::from_millis(100));
    drop(controller_a);
    drop(a_peer);

    let dead = endpoint
        .open(65536, None, Instant::now() + Duration::from_millis(200))
        .unwrap();
    assert!(dead.is_none(), "disconnected waiter was published as ready");

    let (received, worker) = mpsc::channel();
    let c_address = address;
    let c_path = path.to_owned();
    let c_peer = thread::spawn(move || {
        let result = client(
            format!("ws://{c_address}{c_path}"),
            TcpStream::connect(c_address).unwrap(),
        );
        received.send(result.is_ok()).unwrap();
        result
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let controller_c = loop {
        if let Some(socket) = endpoint.open(65536, None, deadline).unwrap() {
            break socket;
        }
        assert!(Instant::now() < deadline, "C was not admitted after B disconnected");
        thread::sleep(Duration::from_millis(1));
    };
    assert!(worker.recv_timeout(Duration::from_secs(1)).unwrap());
    let c_peer = c_peer.join().unwrap().unwrap().0;
    drop(controller_c);
    drop(c_peer);
}

#[test]
fn listener_waiter_shutdown_wakes_and_joins_valid_upgrade() {
    listener_waiter_cancellation(false);
}

#[test]
fn listener_waiter_rotation_cancels_old_generation() {
    listener_waiter_cancellation(true);
}

#[test]
fn listener_waiter_authenticates_after_300ms_controller_close() {
    listener_waiter_handover(Duration::from_millis(300));
}

#[test]
fn listener_waiter_authenticates_after_2s_controller_close() {
    listener_waiter_handover(Duration::from_secs(2));
}
