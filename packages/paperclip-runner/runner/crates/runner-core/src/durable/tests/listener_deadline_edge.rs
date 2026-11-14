// Real-loopback regression probes adapted from RFL's N1 attack (listener5).
// Keep: one-use bootstrap trust boundary; a deadline race must not kill runnerd.
// Late challenges may fail retryably, but must never make the ticket ambiguous.
use tungstenite::protocol::Role;

fn edge_controller_finish(
    mut socket: WebSocket<TcpStream>,
    config: DurableRunnerConfig,
    state: DurableState,
    auth_delay: Duration,
) -> Result<(), String> {
    thread::sleep(auth_delay);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
                "judge_connection",
                Some("lease-secret"),
                expires,
                0,
                vec![],
            ),
        );
        // Prove secure transport works beyond the ingress deadline, not just HTTP 101.
        thread::sleep(Duration::from_millis(10));
        send_secure(
            &mut socket,
            &mut secure,
            &config,
            &json!({"judge_alive": true}),
        );
    }))
    .map_err(|_| "authentication helper failed (see bounded peer error above)".to_owned())
}

/// F2 edge: a REAL controller whose valid challenge arrives right at the 2.5s boundary.
/// Counts outcomes; `fatal` = runner error with bootstrap_maybe_consumed=true, which
/// runner.rs turns into "bootstrap connection failed closed; provide a fresh one-use ticket".
fn listener_deadline_edge_trial(target_us: u64) -> (&'static str, bool, u128) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let endpoint =
        RunnerTransportEndpoint::from_listener(listener, "/api/runner/v1/connect/run_1".to_owned());
    let mut config = config(address.port());
    config.max_runtime = Duration::from_secs(8);
    let state = test_state(&config);
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let peer_config = config.clone();
    let peer_state = state.clone();
    let started = Instant::now();
    let peer = thread::spawn(move || {
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(1)).unwrap();
        let connected = Instant::now();
        stream
            .set_read_timeout(Some(Duration::from_millis(3200)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_millis(3200)))
            .unwrap();
        let request = format!("GET /api/runner/v1/connect/run_1 HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") && response.len() < 4096 {
            let mut b = [0];
            if stream.read_exact(&mut b).is_err() {
                return false;
            }
            response.push(b[0]);
        }
        if !response.starts_with(b"HTTP/1.1 101") {
            return false;
        }
        let ws = WebSocket::from_raw_socket(stream, Role::Client, None);
        let target = connected + Duration::from_micros(target_us);
        let coarse = target
            .checked_sub(Duration::from_millis(3))
            .unwrap_or(target);
        thread::sleep(coarse.saturating_duration_since(Instant::now()));
        while Instant::now() < target {
            std::hint::spin_loop();
        }
        edge_controller_finish(ws, peer_config, peer_state, Duration::ZERO).is_ok()
    });
    // Tick late so that the 2.5s total deadline (not AUTH_TIMEOUT = 2s from take) is binding.
    thread::sleep(Duration::from_millis(700));
    let deadline = started + Duration::from_secs(6);
    let mut outcome = "none";
    while Instant::now() < deadline {
        match AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            Some(&ticket),
            None,
            deadline,
        ) {
            Ok(Some((mut transport, _))) => {
                let alive = transport
                    .receive_json_until(Some(deadline))
                    .ok()
                    .flatten()
                    .is_some_and(|v| v["judge_alive"] == true);
                outcome = if alive { "auth_ok" } else { "auth_ok_no_frame" };
                break;
            }
            Ok(None) => {
                if peer.is_finished() {
                    outcome = "expired_before_take";
                    break;
                }
                thread::sleep(Duration::from_micros(200));
            }
            Err(e) => {
                outcome = if e.bootstrap_maybe_consumed {
                    "FATAL_bootstrap_maybe_consumed"
                } else {
                    "retryable_err"
                };
                if e.bootstrap_maybe_consumed {
                    eprintln!(
                        "EDGE_FATAL_ERROR target_us={target_us} runner_error=\"{e}\" at_ms={}",
                        started.elapsed().as_millis()
                    );
                }
                break;
            }
        }
    }
    let elapsed = started.elapsed().as_millis();
    let peer_ok = peer.join().unwrap();
    (outcome, peer_ok, elapsed)
}

#[test]
fn listener_deadline_edge_bootstrap_is_never_ambiguous() {
    let results = Arc::new(std::sync::Mutex::new(Vec::new()));
    let workers: Vec<_> = (0..12u64)
        .map(|w| {
            let results = results.clone();
            thread::spawn(move || {
                for t in 0..10u64 {
                    // challenge release time: 2496.0ms .. 2500.8ms after the peer's connect() returned
                    let target_us = 2_496_000 + (w * 10 + t) * 40;
                    let r = listener_deadline_edge_trial(target_us);
                    results.lock().unwrap().push((target_us, r));
                }
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    let mut results = results.lock().unwrap().clone();
    results.sort();
    let mut counts = std::collections::BTreeMap::new();
    for (target_us, (outcome, peer_ok, elapsed)) in &results {
        *counts
            .entry(format!("{outcome}/peer_saw_auth_ok={peer_ok}"))
            .or_insert(0usize) += 1;
        if outcome.starts_with("FATAL") {
            eprintln!("EDGE target_us={target_us} outcome={outcome} peer_completed_auth={peer_ok} elapsed_ms={elapsed}");
        }
    }
    eprintln!("EDGE trials={} counts={counts:?}", results.len());
    assert!(
        results
            .iter()
            .any(|(_, (outcome, peer_ok, _))| *outcome == "auth_ok" && *peer_ok),
        "the deadline sweep must include successful mutual authentication and an encrypted frame"
    );
    let fatal = results
        .iter()
        .filter(|(_, (o, _, _))| o.starts_with("FATAL"))
        .count();
    assert_eq!(fatal, 0, "a valid controller answering at the total deadline made the one-use bootstrap ambiguous (runner exits fatal)");
}

#[test]
fn listener_deadline_edge_focused_window_is_never_ambiguous() {
    let results = Arc::new(std::sync::Mutex::new(Vec::new()));
    let workers: Vec<_> = (0..12u64)
        .map(|w| {
            let results = results.clone();
            thread::spawn(move || {
                for t in 0..10u64 {
                    // challenge release time: 2499.0ms .. 2500.2ms after the peer's connect() returned
                    let target_us = 2_499_000 + (w * 10 + t) * 10;
                    let r = listener_deadline_edge_trial(target_us);
                    results.lock().unwrap().push((target_us, r));
                }
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    let results = results.lock().unwrap().clone();
    let mut counts = std::collections::BTreeMap::new();
    for (_, (outcome, peer_ok, _)) in &results {
        *counts
            .entry(format!("{outcome}/peer_saw_auth_ok={peer_ok}"))
            .or_insert(0usize) += 1;
    }
    eprintln!("EDGE_FOCUSED trials={} counts={counts:?}", results.len());
    assert!(
        results
            .iter()
            .any(|(_, (outcome, peer_ok, _))| *outcome == "auth_ok" && *peer_ok),
        "the deadline sweep must include successful mutual authentication and an encrypted frame"
    );
    let fatal = results
        .iter()
        .filter(|(_, (o, _, _))| o.starts_with("FATAL"))
        .count();
    assert_eq!(fatal, 0, "a valid controller answering at the total deadline made the one-use bootstrap ambiguous (runner exits fatal)");
}
