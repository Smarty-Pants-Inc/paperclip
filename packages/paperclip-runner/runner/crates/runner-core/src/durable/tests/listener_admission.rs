// Real-socket reproductions of the independent listener review's F1/F2.
// Keep: admission/authentication trust boundary and recorded ingress starvation.
const INGRESS_TOTAL_BUDGET: Duration = Duration::from_millis(2500);

struct ReplenishingIngress {
    worker: Option<thread::JoinHandle<usize>>,
    started: Instant,
}

impl ReplenishingIngress {
    fn start(address: SocketAddr, partial: bool) -> Self {
        let started = Instant::now();
        let (ready, initialized) = mpsc::channel();
        let counter = Arc::new(AtomicUsize::new(0));
        let worker_counter = counter.clone();
        let worker = thread::spawn(move || {
            let mut peers = Vec::new();
            let mut created = 0;
            let mut notified = false;
            while started.elapsed() < Duration::from_secs(13) {
                peers.retain(|stream: &TcpStream| {
                    let mut byte = [0];
                    matches!(stream.peek(&mut byte), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
                });
                while peers.len() < 16 {
                    let mut stream = TcpStream::connect(address).unwrap();
                    stream.set_nonblocking(true).unwrap();
                    if partial {
                        let _ =
                            stream.write_all(b"GET /api/runner/v1/connect/run_1 HTTP/1.1\r\nHost:");
                    }
                    peers.push(stream);
                    created += 1;
                    worker_counter.fetch_add(1, Ordering::Relaxed);
                }
                if !notified {
                    ready.send(()).unwrap();
                    notified = true;
                }
                thread::sleep(Duration::from_millis(1));
            }
            created
        });
        initialized.recv_timeout(Duration::from_secs(2)).unwrap();
        // Replenish for ten seconds BEFORE the controller arrives: several
        // complete HTTP timeout cycles, not just one initial saturated batch.
        thread::sleep(Duration::from_secs(10));
        let flood = Self {
            worker: Some(worker),
            started,
        };
        let created = counter.load(Ordering::Relaxed);
        eprintln!(
            "before controller: flood_elapsed_ms={} peers_created={created}",
            started.elapsed().as_millis()
        );
        assert!(
            created >= 64,
            "several silent-peer populations must expire and refill before controller admission"
        );
        flood
    }

    fn finish(&mut self) {
        if let Some(worker) = self.worker.take() {
            let created = worker.join().unwrap();
            eprintln!(
                "replenishing ingress: elapsed_ms={} peers_created={created}",
                self.started.elapsed().as_millis()
            );
            assert!(self.started.elapsed() >= Duration::from_secs(10));
            assert!(created > 16, "the flood was not replenished");
        }
    }
}

impl Drop for ReplenishingIngress {
    fn drop(&mut self) {
        self.finish();
    }
}

fn judge_replenishing_ingress(partial: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let path = "/api/runner/v1/connect/run_1".to_owned();
    let endpoint = RunnerTransportEndpoint::from_listener(listener, path.clone());
    let mut config = config(address.port());
    config.max_runtime = Duration::from_secs(20);
    let state = test_state(&config);
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let mut flood = ReplenishingIngress::start(address, partial);
    let peer_config = config.clone();
    let peer_state = state.clone();
    let (release, held) = mpsc::channel();
    let started = Instant::now();
    let peer = thread::spawn(move || {
        let stream = TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(INGRESS_TOTAL_BUDGET)).unwrap();
        stream
            .set_write_timeout(Some(INGRESS_TOTAL_BUDGET))
            .unwrap();
        let (mut socket, _) = client(format!("ws://{address}{path}"), stream)
            .map_err(|error| format!("controller upgrade: {error}"))?;
        let expires = current_unix_ms().unwrap() + 60_000;
        let mut secure = server_authenticate(
            &mut socket,
            &peer_config,
            &peer_state,
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
            &peer_config,
            &welcome(
                &peer_state,
                "connection_1",
                Some("lease-secret"),
                expires,
                0,
                vec![],
            ),
        );
        held.recv_timeout(Duration::from_secs(15)).unwrap();
        send_secure(
            &mut socket,
            &mut secure,
            &peer_config,
            &json!({"stillLive": true}),
        );
        Ok::<_, String>(())
    });
    let deadline = started + INGRESS_TOTAL_BUDGET;
    let result = loop {
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
    };
    let admission_elapsed = started.elapsed();
    let second_controller = if matches!(result, Ok(Some(_))) {
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        Some(client(
            format!("ws://{address}/api/runner/v1/connect/run_1"),
            stream,
        ))
    } else {
        None
    };
    // Always join the real flood and peer, including on the RED path.
    flood.finish();
    let _ = release.send(());
    let peer_result = peer.join().unwrap();
    eprintln!("replenishing partial={partial}: controller_elapsed_ms={} authenticated={} peer={peer_result:?}", admission_elapsed.as_millis(), matches!(result, Ok(Some(_))));
    let (mut transport, _) = result
        .expect("controller connect failed")
        .expect("no controller admitted");
    assert!(admission_elapsed < INGRESS_TOTAL_BUDGET);
    // This extra, unfinished upgrade may wait or be evicted by the ongoing
    // flood. Either way it must not receive HTTP 101 or displace the live
    // controller, whose encrypted frame is checked below. Non-flooded queueing
    // and its deadline are covered by the dedicated waiter/listener tests.
    assert!(
        matches!(second_controller, Some(Err(_))),
        "a second controller must not displace the live controller under flood"
    );
    peer_result.expect("controller failed under replenishing ingress");
    assert_eq!(
        transport
            .receive_json_until(Some(Instant::now() + Duration::from_secs(1)))
            .unwrap()
            .unwrap()["stillLive"],
        true
    );
}

#[test]
fn judge_ingress_replenishing_silent_peers_admit_controller() {
    judge_replenishing_ingress(false);
}

#[test]
fn judge_ingress_replenishing_partial_http_peers_admit_controller() {
    judge_replenishing_ingress(true);
}

#[test]
fn judge_ingress_one_total_deadline_includes_ready_wait_and_authentication() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let path = "/api/runner/v1/connect/run_1".to_owned();
    let endpoint = RunnerTransportEndpoint::from_listener(listener, path.clone());
    let mut config = config(address.port());
    config.max_runtime = Duration::from_secs(10);
    let state = test_state(&config);
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let started = Instant::now();
    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let (mut peer, _) = client(format!("ws://{address}{path}"), stream).unwrap();
    thread::sleep(Duration::from_millis(1500));
    let (hello_sent, hello_received) = mpsc::channel();
    let peer = thread::spawn(move || {
        let hello = receive_plain(&mut peer, config.max_frame_bytes).unwrap();
        assert_eq!(hello["kind"], "auth_hello");
        hello_sent.send(()).unwrap();
        let result = peer.read();
        assert!(
            result.is_err(),
            "unauthenticated peer received an extra frame"
        );
    });
    let result = AuthenticatedTransport::connect(
        &endpoint,
        &config,
        &state,
        Some(&ticket),
        None,
        Instant::now() + Duration::from_secs(10),
    );
    hello_received.recv_timeout(Duration::from_secs(1)).unwrap();
    peer.join().unwrap();
    let elapsed = started.elapsed();
    let failure = match result {
        Err(failure) => failure,
        _ => panic!("silent peer unexpectedly authenticated"),
    };
    assert!(!failure.bootstrap_maybe_consumed);
    eprintln!(
        "total unauthenticated occupancy_ms={} failure={}",
        elapsed.as_millis(),
        failure.error
    );
    // 200ms is scheduling slack, not a fresh per-stage timeout.
    assert!(elapsed < INGRESS_TOTAL_BUDGET + Duration::from_millis(200));
}

#[test]
fn judge_ingress_authenticated_welcome_keeps_its_existing_budget() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let path = "/api/runner/v1/connect/run_1".to_owned();
    let endpoint = RunnerTransportEndpoint::from_listener(listener, path.clone());
    let mut config = config(address.port());
    config.max_runtime = Duration::from_secs(10);
    let state = test_state(&config);
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let peer_config = config.clone();
    let peer_state = state.clone();
    let peer = thread::spawn(move || {
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (mut socket, _) = client(format!("ws://{address}{path}"), stream).unwrap();
        let expires = current_unix_ms().unwrap() + 60_000;
        let mut secure = server_authenticate(
            &mut socket,
            &peer_config,
            &peer_state,
            ServerCredential {
                token: "bootstrap-secret",
                kind: "bootstrap",
                lease_id: None,
                expires_at_unix_ms: expires,
                revocation_epoch: 0,
            },
        );
        // Mutual authentication has finished. Durable controller admission
        // may legitimately take longer than the pre-authentication deadline.
        thread::sleep(Duration::from_secs(3));
        send_secure(
            &mut socket,
            &mut secure,
            &peer_config,
            &welcome(
                &peer_state,
                "connection_1",
                Some("lease-secret"),
                expires,
                0,
                vec![],
            ),
        );
    });
    let deadline = Instant::now() + config.max_runtime;
    let result = loop {
        match AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            Some(&ticket),
            None,
            deadline,
        ) {
            Ok(None) => thread::sleep(Duration::from_millis(1)),
            result => break result,
        }
    };
    peer.join().unwrap();
    assert_eq!(
        result.unwrap().unwrap().1.connection.connection_id,
        "connection_1"
    );
}
