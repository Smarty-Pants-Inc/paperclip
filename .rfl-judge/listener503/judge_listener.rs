// Independent RFL acceptance checks. Only pre-existing protocol helpers are reused;
// none of the candidate's waiter/flood test helpers are used.
// Keep: real authenticated trust boundary, live-controller exclusivity and field reconnect failure.
struct JudgePeer {
    commands: mpsc::Sender<Option<u64>>,
    upgraded: mpsc::Receiver<Result<(), String>>,
    worker: thread::JoinHandle<Result<(), String>>,
}

fn judge_peer(address: SocketAddr, name: &'static str) -> JudgePeer {
    let cfg = config(address.port());
    let state = test_state(&cfg);
    let (commands, receive) = mpsc::channel();
    let (report, upgraded) = mpsc::channel();
    let worker = thread::spawn(move || {
        let stream = TcpStream::connect(address).map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(Duration::from_secs(18))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut socket = match client(format!("ws://{address}/api/runner/v1/connect/run_1"), stream) {
            Ok((socket, _)) => { let _ = report.send(Ok(())); socket }
            Err(e) => {
                let text = format!("{name} upgrade: {e}");
                let _ = report.send(Err(text.clone()));
                return Err(text);
            }
        };
        let expires = current_unix_ms().unwrap() + 60_000;
        let mut channel = server_authenticate(&mut socket, &cfg, &state, ServerCredential {
            token: "judge-test-only", kind: "bootstrap", lease_id: None,
            expires_at_unix_ms: expires, revocation_epoch: 0,
        });
        send_secure(&mut socket, &mut channel, &cfg,
            &welcome(&state, name, Some("judge-lease-only"), expires, 0, vec![]));
        send_secure(&mut socket, &mut channel, &cfg, &json!({"peer": name, "tick": 0}));
        while let Ok(Some(tick)) = receive.recv_timeout(Duration::from_secs(20)) {
            send_secure(&mut socket, &mut channel, &cfg, &json!({"peer": name, "tick": tick}));
        }
        Ok(())
    });
    JudgePeer { commands, upgraded, worker }
}

fn judge_endpoint() -> (RunnerTransportEndpoint, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    (RunnerTransportEndpoint::from_listener(listener, "/api/runner/v1/connect/run_1".into()), address)
}

fn judge_auth(endpoint: &RunnerTransportEndpoint, address: SocketAddr, budget: Duration)
    -> Result<AuthenticatedTransport, String> {
    let cfg = config(address.port());
    let state = test_state(&cfg);
    let ticket = BootstrapTicket::new("judge-test-only".into()).unwrap();
    let deadline = Instant::now() + budget;
    loop {
        match AuthenticatedTransport::connect(endpoint, &cfg, &state, Some(&ticket), None, deadline) {
            Ok(Some((transport, _))) => return Ok(transport),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
            Ok(None) => return Err("no admitted controller before judge deadline".into()),
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn judge_frame(transport: &mut AuthenticatedTransport) -> Value {
    transport.receive_json_until(Some(Instant::now() + Duration::from_secs(1)))
        .unwrap().expect("encrypted controller frame")
}

fn judge_stop(peer: JudgePeer) -> Result<(), String> {
    let _ = peer.commands.send(None);
    peer.worker.join().map_err(|_| "peer thread panic".to_owned())?
}

fn judge_reconnect(delay: Duration) {
    let (endpoint, address) = judge_endpoint();
    let a = judge_peer(address, "A");
    let mut active = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
    assert_eq!(judge_frame(&mut active)["peer"], "A");
    a.upgraded.recv().unwrap().unwrap();
    let start = Instant::now();
    let b = judge_peer(address, "B");
    let early = b.upgraded.recv_timeout(delay);
    thread::sleep(delay.saturating_sub(start.elapsed()));
    // Prove the old controller is not evicted: it still sends authenticated data.
    a.commands.send(Some(1)).unwrap();
    assert_eq!(judge_frame(&mut active)["tick"], 1);
    assert!(endpoint.open(65536, None, Instant::now() + Duration::from_secs(1)).unwrap().is_none());
    drop(active);
    judge_stop(a).unwrap();
    let admitted = if early.is_err() { judge_auth(&endpoint, address, Duration::from_secs(3)) }
        else { Err(format!("premature B outcome: {early:?}")) };
    let outcome = admitted.map(|mut next| {
        let frame = judge_frame(&mut next);
        assert_eq!(frame["peer"], "B");
    });
    let peer_outcome = judge_stop(b);
    eprintln!("JUDGE reconnect delay_ms={} elapsed_ms={} result={outcome:?} peer={peer_outcome:?}",
        delay.as_millis(), start.elapsed().as_millis());
    assert!(early.is_err(), "reconnect must remain pending while A is live: {early:?}");
    outcome.unwrap();
    peer_outcome.unwrap();
}

#[test]
fn independent_reconnect_waits_300ms() { judge_reconnect(Duration::from_millis(300)); }
#[test]
fn independent_reconnect_waits_2s() { judge_reconnect(Duration::from_secs(2)); }

#[test]
fn independent_release_b_admission_and_c_arrival_never_double_admit() {
    let mut first_b = 0;
    let mut first_c = 0;
    for trial in 0..100 {
        let (endpoint, address) = judge_endpoint();
        let a = judge_peer(address, "A");
        let mut active = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
        assert_eq!(judge_frame(&mut active)["peer"], "A");
        let b = judge_peer(address, "B");
        assert!(b.upgraded.recv_timeout(Duration::from_millis(5)).is_err());
        // C starts concurrently with A's release and B's admission.
        let c = judge_peer(address, "C");
        if trial % 2 == 0 { thread::yield_now(); }
        drop(active);
        judge_stop(a).unwrap();
        let mut first = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
        let label = judge_frame(&mut first)["peer"].as_str().unwrap().to_owned();
        let (winner, waiting) = if label == "B" { first_b += 1; (&b, &c) }
            else { assert_eq!(label, "C"); first_c += 1; (&c, &b) };
        winner.upgraded.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
        assert!(waiting.upgraded.recv_timeout(Duration::from_millis(5)).is_err(),
            "trial {trial}: two live upgraded controllers");
        assert!(endpoint.open(65536, None, Instant::now() + Duration::from_secs(1)).unwrap().is_none());
        winner.commands.send(Some(1)).unwrap();
        assert_eq!(judge_frame(&mut first)["tick"], 1);
        drop(first);
        let mut second = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
        let other = judge_frame(&mut second)["peer"].as_str().unwrap().to_owned();
        assert_ne!(label, other);
        drop(second);
        judge_stop(b).unwrap();
        judge_stop(c).unwrap();
    }
    eprintln!("JUDGE race: 100 trials, first B={first_b}, first C={first_c}, no double admission");
}

fn judge_raw_request(address: SocketAddr, path: &str) -> TcpStream {
    let mut socket = TcpStream::connect(address).unwrap();
    socket.write_all(format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").as_bytes()).unwrap();
    socket
}

#[test]
fn independent_waiting_reconnect_survives_unauthenticated_valid_request_flood() {
    let (endpoint, address) = judge_endpoint();
    let a = judge_peer(address, "A");
    let mut active = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
    assert_eq!(judge_frame(&mut active)["peer"], "A");
    let b = judge_peer(address, "B");
    assert!(b.upgraded.recv_timeout(Duration::from_millis(100)).is_err());
    let mut attackers = Vec::new();
    // No attacker has a bootstrap credential, PRP proof or even a WebSocket frame.
    for _ in 0..32 {
        attackers.push(judge_raw_request(address, "/api/runner/v1/connect/run_1"));
        thread::sleep(Duration::from_millis(3));
    }
    let b_while_a_live = b.upgraded.recv_timeout(Duration::from_millis(100));
    a.commands.send(Some(2)).unwrap();
    assert_eq!(judge_frame(&mut active)["tick"], 2);
    drop(active);
    judge_stop(a).unwrap();
    drop(attackers);
    let authenticated = if b_while_a_live.is_err() {
        judge_auth(&endpoint, address, Duration::from_secs(4)).map(|mut next| judge_frame(&mut next))
    } else { Err(format!("B was evicted while A was live: {b_while_a_live:?}")) };
    drop(endpoint);
    let b_result = judge_stop(b);
    eprintln!("JUDGE credential-free flood: reconnect={authenticated:?}, peer={b_result:?}");
    authenticated.expect("unauthenticated waiters must not block the legitimate reconnect");
    b_result.unwrap();
}

#[test]
fn independent_disconnected_waiter_does_not_claim_released_admission() {
    let (endpoint, address) = judge_endpoint();
    let a = judge_peer(address, "A");
    let mut active = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
    assert_eq!(judge_frame(&mut active)["peer"], "A");
    let abandoned = judge_raw_request(address, "/api/runner/v1/connect/run_1");
    thread::sleep(Duration::from_millis(100));
    // On the base this peer is already refused/closed; either way it is abandoned.
    let _ = abandoned.shutdown(std::net::Shutdown::Both);
    drop(abandoned);
    thread::sleep(Duration::from_millis(100));
    drop(active);
    judge_stop(a).unwrap();
    // A closed, queued TCP stream must not be published as the next controller.
    thread::sleep(Duration::from_millis(100));
    let dead = endpoint.open(65536, None, Instant::now() + Duration::from_secs(1)).unwrap();
    let published_dead = dead.is_some();
    drop(dead);
    let c = judge_peer(address, "C");
    let retry = judge_auth(&endpoint, address, Duration::from_secs(3)).map(|mut next| judge_frame(&mut next));
    let c_result = judge_stop(c);
    eprintln!("JUDGE disconnect: dead_waiter_published={published_dead}, retry={retry:?}");
    retry.unwrap();
    c_result.unwrap();
    assert!(!published_dead, "disconnected waiter was promoted into the sole controller slot");
}

#[test]
fn independent_waiter_deadline_15s_preserves_live_authenticated_writer() {
    let (endpoint, address) = judge_endpoint();
    let a = judge_peer(address, "A");
    let mut active = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
    assert_eq!(judge_frame(&mut active)["peer"], "A");
    let b = judge_peer(address, "B");
    let start = Instant::now();
    for tick in 1..=14 {
        assert!(b.upgraded.recv_timeout(Duration::from_secs(1)).is_err());
        a.commands.send(Some(tick)).unwrap();
        assert_eq!(judge_frame(&mut active)["tick"], tick);
    }
    let refused = b.upgraded.recv_timeout(Duration::from_secs(3)).unwrap();
    let elapsed = start.elapsed();
    a.commands.send(Some(15)).unwrap();
    assert_eq!(judge_frame(&mut active)["tick"], 15);
    assert!(endpoint.open(65536, None, Instant::now() + Duration::from_secs(1)).unwrap().is_none());
    drop(active);
    judge_stop(a).unwrap();
    let b_result = judge_stop(b);
    eprintln!("JUDGE permanent live owner: elapsed_ms={} refusal={refused:?} peer={b_result:?}", elapsed.as_millis());
    assert!(refused.unwrap_err().contains("503"));
    assert!(elapsed >= Duration::from_secs(15) && elapsed < Duration::from_secs(17));
}
