// Inbound liveness of a listener-mode (listen_ws) controller connection,
// P0 #20825 (runnerd side). The listener has one controller slot; a controller
// that vanished without a FIN (half-open) used to hold it until runnerd's next
// write (its lease renewal, ~30 min later), so every server redial got 503.
// The controller pings every 20 s and declares the runner dead after 90 s
// (server/src/realtime/runner-prp-outbound.ts); runnerd closes after 120 s
// without ANY inbound frame. Time is a paused per-thread VirtualClock: minutes
// of protocol time run in milliseconds of wall time. Wall-clock bounds below
// only cap how long a test waits to OBSERVE a step; they are not the contract.

/// The contract: close after 120 s without any inbound frame, never earlier.
const LIVENESS_SILENCE: Duration = Duration::from_secs(120);
/// Tolerance either side of the contract value, in virtual time.
const LIVENESS_TOLERANCE: Duration = Duration::from_secs(1);
/// The controller's protocol ping cadence.
const LIVENESS_PING_INTERVAL: Duration = Duration::from_secs(20);
/// A long idle period / long tool call: 15 pings.
const LIVENESS_IDLE_PERIOD: Duration = Duration::from_secs(300);
/// Wall time for the runner thread to run >= 3 RUNTIME_READ_TIMEOUT cycles.
const LIVENESS_SETTLE: Duration = Duration::from_millis(750);
/// Wall-time cap to observe a close once virtual time has passed the window.
const LIVENESS_OBSERVE: Duration = Duration::from_secs(5);
const LIVENESS_PATH: &str = "/api/runner/v1/connect/run_1";

/// Dial like the server's outbound connector: one upgrade attempt. A refused
/// upgrade (the listener's 503 after its 15 s controller wait) is an error,
/// never a hang, because the read timeout outlasts that wait.
fn liveness_dial(address: SocketAddr) -> Result<WebSocket<TcpStream>, String> {
    let started = Instant::now();
    let stream = loop {
        match TcpStream::connect(address) {
            Ok(stream) => break stream,
            // run_durable_runner binds the listener on its own thread.
            Err(_) if started.elapsed() < LIVENESS_OBSERVE => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(format!("controller TCP dial failed: {error}")),
        }
    };
    stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(20))).unwrap();
    client(format!("ws://{address}{LIVENESS_PATH}"), stream)
        .map(|(socket, _)| socket)
        .map_err(|error| {
            format!(
                "the controller's fresh upgrade was refused after {} ms: {error}",
                started.elapsed().as_millis()
            )
        })
}

/// The server's redial while the stale leg may still hold the one slot. Once
/// virtual time is past the window, runnerd must free the slot within a few
/// read cycles, far inside the listener's 15 s controller wait.
fn liveness_redial(address: SocketAddr) -> WebSocket<TcpStream> {
    let started = Instant::now();
    let socket = liveness_dial(address).unwrap();
    assert!(
        started.elapsed() < LIVENESS_OBSERVE,
        "the redial was admitted only after {} ms: the stale leg held the slot",
        started.elapsed().as_millis()
    );
    socket
}

/// Send a real WebSocket protocol Ping frame and wait for runnerd's Pong. The
/// Pong proves runnerd read the Ping at the current virtual time. Then let
/// runnerd's read time out a few times, so its silence check really runs
/// between pings instead of chaining one read into the next ping.
fn liveness_ping(socket: &mut WebSocket<TcpStream>, sequence: u32) {
    let payload = sequence.to_be_bytes().to_vec();
    socket.send(Message::Ping(payload.clone().into())).unwrap();
    let deadline = Instant::now() + LIVENESS_OBSERVE;
    loop {
        assert!(
            Instant::now() < deadline,
            "runnerd did not answer protocol ping {sequence}"
        );
        match socket.read() {
            Ok(Message::Pong(bytes)) if bytes.as_ref() == payload.as_slice() => break,
            Ok(Message::Pong(_)) => continue,
            Ok(other) => panic!("unexpected frame while waiting for pong {sequence}: {other:?}"),
            Err(error) => panic!(
                "runnerd closed a pinged connection (false liveness timeout) at ping {sequence}: {error}"
            ),
        }
    }
    thread::sleep(LIVENESS_SETTLE);
    assert!(
        !liveness_runner_closed(socket),
        "runnerd closed a pinged connection (false liveness timeout) after ping {sequence}"
    );
}

/// Non-consuming check: has runnerd closed its side of this connection?
fn liveness_runner_closed(socket: &WebSocket<TcpStream>) -> bool {
    let stream = socket.get_ref();
    stream.set_nonblocking(true).unwrap();
    let mut byte = [0_u8; 1];
    let closed = match stream.peek(&mut byte) {
        Ok(0) => true,
        Ok(_) => false,
        Err(error) => error.kind() != io::ErrorKind::WouldBlock,
    };
    stream.set_nonblocking(false).unwrap();
    closed
}

/// Wait (bounded wall time) until runnerd closes this connection.
fn liveness_wait_for_runner_close(socket: &mut WebSocket<TcpStream>) -> bool {
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let deadline = Instant::now() + LIVENESS_OBSERVE;
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Close(_)) => return true,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return true,
        }
    }
    false
}

/// Advance virtual time to `at`, let runnerd run a few read cycles, and
/// require that the connection is still open (no early close).
fn liveness_assert_open_at(
    clock: &test_clock::VirtualClock,
    socket: &WebSocket<TcpStream>,
    at: Duration,
) {
    clock.set(at);
    thread::sleep(LIVENESS_SETTLE);
    assert!(
        !liveness_runner_closed(socket),
        "runnerd closed the connection early, at virtual {} s",
        at.as_secs()
    );
}

/// Advance virtual time to `at` and require runnerd to close the connection.
fn liveness_assert_closed_at(
    clock: &test_clock::VirtualClock,
    socket: &mut WebSocket<TcpStream>,
    at: Duration,
) {
    clock.set(at);
    assert!(
        liveness_wait_for_runner_close(socket),
        "runnerd kept an inbound-silent connection open past {} s (virtual {} s)",
        LIVENESS_SILENCE.as_secs(),
        at.as_secs()
    );
}

fn liveness_receive_secure(
    socket: &mut WebSocket<TcpStream>,
    secure: &mut SecureChannel,
    config: &DurableRunnerConfig,
    within: Duration,
) -> Value {
    let frame = receive_plain_until(socket, config.max_frame_bytes, Instant::now() + within)
        .unwrap_or_else(|error| panic!("controller receive failed: {error}"));
    secure.decrypt(&frame, true).unwrap()
}

fn liveness_bootstrap(
    socket: &mut WebSocket<TcpStream>,
    config: &DurableRunnerConfig,
    state: &DurableState,
    expires: u64,
) -> SecureChannel {
    server_authenticate(
        socket,
        config,
        state,
        ServerCredential {
            token: "bootstrap-secret",
            kind: "bootstrap",
            lease_id: None,
            expires_at_unix_ms: expires,
            revocation_epoch: 0,
        },
    )
}

fn liveness_lease(
    socket: &mut WebSocket<TcpStream>,
    config: &DurableRunnerConfig,
    state: &DurableState,
    expires: u64,
) -> SecureChannel {
    server_authenticate(
        socket,
        config,
        state,
        ServerCredential {
            token: "lease-secret",
            kind: "lease",
            lease_id: Some("lease_1"),
            expires_at_unix_ms: expires,
            revocation_epoch: 1,
        },
    )
}

/// Sets `finished` when the controller thread exits, even by panic.
struct LivenessFinished(Arc<std::sync::atomic::AtomicBool>);
impl Drop for LivenessFinished {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Transport-level runner side: the listener endpoint, as runnerd's
/// connected loop uses it, on the thread with the virtual clock installed.
fn liveness_connect(
    endpoint: &RunnerTransportEndpoint,
    config: &DurableRunnerConfig,
    state: &DurableState,
    ticket: Option<&BootstrapTicket>,
    lease: Option<&LeaseCredential>,
    finished: &std::sync::atomic::AtomicBool,
) -> Option<(AuthenticatedTransport, Welcome)> {
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline && !finished.load(Ordering::SeqCst) {
        match AuthenticatedTransport::connect(endpoint, config, state, ticket, lease, deadline) {
            Ok(Some(connection)) => return Some(connection),
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(error) => panic!("runner connect failed: {error}"),
        }
    }
    None
}

/// Serve the connection as the connected loop does until the transport
/// reports an error; the caller then drops it, exactly as the loop does.
fn liveness_serve(
    transport: &mut AuthenticatedTransport,
    clock: &test_clock::VirtualClock,
    finished: &std::sync::atomic::AtomicBool,
) -> Result<(Duration, String), String> {
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline && !finished.load(Ordering::SeqCst) {
        match transport.receive_json() {
            Ok(None) => {}
            Ok(Some(value)) => return Err(format!("unexpected application frame: {value}")),
            Err(error) => return Ok((clock.elapsed(), error.to_string())),
        }
    }
    Err("runnerd never closed the inbound-silent connection".to_owned())
}

fn liveness_listener_endpoint() -> (RunnerTransportEndpoint, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    (
        RunnerTransportEndpoint::from_listener(listener, LIVENESS_PATH.to_owned()),
        address,
    )
}

/// Judged row (a): real protocol Ping frames every 20 s over a 5-minute idle
/// period never time out, and the clock is FED by control frames (Ping and an
/// unsolicited Pong): silence is measured from the last control frame.
#[test]
fn inbound_liveness_protocol_pings_keep_an_idle_listener_connection_alive() {
    let (endpoint, address) = liveness_listener_endpoint();
    let mut config = config(address.port());
    config.max_runtime = Duration::from_secs(60);
    let state = test_state(&config);
    let clock = test_clock::VirtualClock::new();
    clock.install();
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (connected, runner_connected) = mpsc::channel();
    let controller = {
        let (config, state, clock, finished) =
            (config.clone(), state.clone(), clock.clone(), finished.clone());
        thread::spawn(move || {
            let _finished = LivenessFinished(finished);
            let mut socket = liveness_dial(address).unwrap();
            let expires = current_unix_ms().unwrap() + 600_000;
            let mut secure = liveness_bootstrap(&mut socket, &config, &state, expires);
            let greeting = welcome(&state, "connection_1", Some("lease-secret"), expires, 0, vec![]);
            send_secure(&mut socket, &mut secure, &config, &greeting);
            runner_connected
                .recv_timeout(LIVENESS_OBSERVE)
                .expect("runnerd did not finish authentication");
            let mut sequence = 0;
            while clock.elapsed() < LIVENESS_IDLE_PERIOD {
                sequence += 1;
                clock.set(LIVENESS_PING_INTERVAL * sequence);
                liveness_ping(&mut socket, sequence);
            }
            assert_eq!(sequence, 15);
            assert!(!liveness_runner_closed(&socket));
            // An unsolicited Pong (RFC 6455 5.5.3) is inbound traffic too.
            let pong_at = LIVENESS_IDLE_PERIOD + Duration::from_secs(100);
            clock.set(pong_at);
            socket.send(Message::Pong(vec![0xA5].into())).unwrap();
            // A Pong gets no reply to wait on: give runnerd read cycles to
            // take it at virtual `pong_at` before time moves on.
            thread::sleep(LIVENESS_SETTLE);
            liveness_assert_open_at(
                &clock,
                &socket,
                pong_at + LIVENESS_SILENCE - LIVENESS_TOLERANCE,
            );
            liveness_assert_closed_at(
                &clock,
                &mut socket,
                pong_at + LIVENESS_SILENCE + LIVENESS_TOLERANCE,
            );
        })
    };
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let outcome = liveness_connect(&endpoint, &config, &state, Some(&ticket), None, &finished)
        .map(|(mut transport, _)| {
            connected.send(()).unwrap();
            let outcome = liveness_serve(&mut transport, &clock, &finished);
            drop(transport);
            outcome
        });
    if let Err(panic) = controller.join() {
        std::panic::resume_unwind(panic);
    }
    let (closed_at, reason) = outcome.expect("runner never connected").unwrap();
    assert_eq!(reason, "inbound_silence_timeout");
    assert_eq!(closed_at, Duration::from_secs(300 + 100 + 120 + 1));
}

/// Judged row (b): a silent peer (no FIN, no frames) is closed at 120 s +/- 1 s;
/// the slot frees and a fresh controller upgrade, dialed while the slot was
/// still held, is admitted and mutually authenticates.
#[test]
fn inbound_liveness_silent_peer_is_closed_and_a_fresh_upgrade_authenticates() {
    let (endpoint, address) = liveness_listener_endpoint();
    let mut config = config(address.port());
    config.max_runtime = Duration::from_secs(60);
    let state = test_state(&config);
    let clock = test_clock::VirtualClock::new();
    clock.install();
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (connected, runner_connected) = mpsc::channel();
    let expires = current_unix_ms().unwrap() + 600_000;
    let controller = {
        let (config, state, clock, finished) =
            (config.clone(), state.clone(), clock.clone(), finished.clone());
        thread::spawn(move || {
            let _finished = LivenessFinished(finished);
            let mut first = liveness_dial(address).unwrap();
            let mut secure = liveness_bootstrap(&mut first, &config, &state, expires);
            let greeting = welcome(&state, "connection_1", Some("lease-secret"), expires, 0, vec![]);
            send_secure(&mut first, &mut secure, &config, &greeting);
            runner_connected
                .recv_timeout(LIVENESS_OBSERVE)
                .expect("runnerd did not finish authentication");
            // Half-open: the controller is gone without a FIN. Hold the TCP
            // socket; never read or write it again.
            liveness_assert_open_at(&clock, &first, LIVENESS_SILENCE - LIVENESS_TOLERANCE);
            clock.set(LIVENESS_SILENCE + LIVENESS_TOLERANCE);
            // The server redials as soon as it declares the old leg dead.
            let mut second = liveness_redial(address);
            assert!(
                liveness_wait_for_runner_close(&mut first),
                "the stale connection was not closed"
            );
            let mut secure = liveness_lease(&mut second, &config, &state, expires);
            send_secure(
                &mut second,
                &mut secure,
                &config,
                &welcome(&state, "connection_2", None, expires, 0, vec![]),
            );
            runner_connected
                .recv_timeout(LIVENESS_OBSERVE)
                .expect("runnerd did not authenticate the fresh upgrade");
        })
    };
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let mut closed = None;
    let mut second_connection = None;
    if let Some((mut first, welcome)) =
        liveness_connect(&endpoint, &config, &state, Some(&ticket), None, &finished)
    {
        connected.send(()).unwrap();
        closed = Some(liveness_serve(&mut first, &clock, &finished));
        drop(first);
        let lease = welcome.lease.expect("bootstrap welcome carries a lease");
        if let Some((_, welcome)) =
            liveness_connect(&endpoint, &config, &state, None, Some(&lease), &finished)
        {
            let _ = connected.send(());
            second_connection = Some(welcome.connection.connection_id);
        }
    }
    if let Err(panic) = controller.join() {
        std::panic::resume_unwind(panic);
    }
    let (closed_at, reason) = closed.expect("runner never connected").unwrap();
    assert_eq!(reason, "inbound_silence_timeout");
    assert!(closed_at >= LIVENESS_SILENCE - LIVENESS_TOLERANCE);
    assert!(closed_at <= LIVENESS_SILENCE + LIVENESS_TOLERANCE);
    assert_eq!(second_connection.as_deref(), Some("connection_2"));
}

fn liveness_command(seq: u64, command_type: &str) -> Value {
    json!({
        "schema": "paperclip.prp.command.v1",
        "commandId": format!("command_{seq}"),
        "controllerSeq": seq,
        "type": command_type,
        "issuedAt": "2026-11-16T00:00:00.000Z",
        "payload": {},
    })
}

/// Deliver a terminal `runner.shutdown` and acknowledge its result so
/// run_durable_runner returns Ok.
fn liveness_shutdown(
    socket: &mut WebSocket<TcpStream>,
    secure: &mut SecureChannel,
    config: &DurableRunnerConfig,
    state: &DurableState,
    connection_id: &str,
    seq: u64,
) {
    send_secure(
        socket,
        secure,
        config,
        &control(
            state,
            connection_id,
            "command",
            liveness_command(seq, "runner.shutdown"),
        ),
    );
    let result = liveness_receive_secure(socket, secure, config, LIVENESS_OBSERVE);
    assert_eq!(result["kind"], "command_result");
    send_secure(
        socket,
        secure,
        config,
        &control(
            state,
            connection_id,
            "command_result_ack",
            json!({
                "commandId": format!("command_{seq}"),
                "commandType": "runner.shutdown",
                "controllerSeq": seq,
                "status": "completed",
            }),
        ),
    );
}

fn liveness_listen_config(name: &str) -> (DurableRunnerConfig, SocketAddr, PathBuf) {
    let port = TcpListener::bind("0.0.0.0:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut config = config(port);
    config.connect_url = format!("listen://0.0.0.0:{port}{LIVENESS_PATH}");
    config.max_runtime = Duration::from_secs(60);
    let directory = std::env::temp_dir().join(format!(
        "paperclip-runner-inbound-liveness-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    config.state_dir = directory.clone();
    (config, ([127, 0, 0, 1], port).into(), directory)
}

fn liveness_final_state(directory: &Path) -> DurableState {
    let store = super::super::DurableStateStore::new(directory).unwrap();
    serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap()
}

/// Judged row (d): the close reason reaches the runner diagnostics as the
/// bounded code only (no peer address, error text or timing).
fn liveness_assert_bounded_diagnostic(state: &DurableState) {
    let mentions: Vec<&String> = state
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.contains("inbound_silence"))
        .collect();
    assert_eq!(
        mentions,
        vec!["inbound_silence_timeout"],
        "diagnostics: {:?}",
        state.diagnostics
    );
}

/// Judged row (c): an active turn in a long tool call (provider quiet, no
/// inbound APPLICATION traffic for 5 minutes, protocol pings arriving) keeps
/// its connection: the tool's output is delivered on the same connection with
/// no reconnect. Once the pings stop, the same clock closes it at 120 s.
#[test]
fn inbound_liveness_long_tool_call_with_pings_keeps_the_active_turn_connected() {
    struct LongToolCall {
        opened: bool,
        emitted: bool,
        tool_done: Arc<std::sync::atomic::AtomicBool>,
        opens: Arc<AtomicUsize>,
    }

    impl super::super::CommandExecutor for LongToolCall {
        fn execute(
            &mut self,
            command: &Command,
        ) -> Result<super::super::CommandExecution, DurableRunnerError> {
            if command.command_type == "session.open" {
                self.opened = true;
                self.opens.fetch_add(1, Ordering::SeqCst);
            }
            Ok(super::super::CommandExecution::result(
                json!({"status": "completed"}),
            ))
        }

        fn poll_events(&mut self) -> Result<Vec<super::super::PolledEvent>, DurableRunnerError> {
            if !self.opened || self.emitted || !self.tool_done.load(Ordering::SeqCst) {
                return Ok(Vec::new());
            }
            self.emitted = true;
            Ok(vec![super::super::PolledEvent {
                executor_event_id: "tool_result_1".to_owned(),
                event_type: "provider.notice.recorded".to_owned(),
                priority: super::super::EventPriority::P1,
                payload: json!({"message": "long tool call finished"}),
            }])
        }

        fn provider_poll_is_live(&self) -> bool {
            self.opened
        }
    }

    let (config, address, directory) = liveness_listen_config("tool-call");
    let state = test_state(&config);
    let clock = test_clock::VirtualClock::new();
    clock.install();
    let tool_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let opens = Arc::new(AtomicUsize::new(0));
    let controller = {
        let (config, state, clock, tool_done) =
            (config.clone(), state.clone(), clock.clone(), tool_done.clone());
        thread::spawn(move || {
            let expires = current_unix_ms().unwrap() + 600_000;
            let mut first = liveness_dial(address).unwrap();
            let mut secure = liveness_bootstrap(&mut first, &config, &state, expires);
            send_secure(
                &mut first,
                &mut secure,
                &config,
                &welcome(
                    &state,
                    "connection_1",
                    Some("lease-secret"),
                    expires,
                    0,
                    vec![liveness_command(1, "session.open")],
                ),
            );
            let opened = liveness_receive_secure(&mut first, &mut secure, &config, LIVENESS_OBSERVE);
            assert_eq!(opened["kind"], "command_result");
            // The turn is active; its tool call runs for 5 minutes with no
            // inbound application traffic. Only protocol pings arrive.
            let mut sequence = 0;
            while clock.elapsed() < LIVENESS_IDLE_PERIOD {
                sequence += 1;
                clock.set(LIVENESS_PING_INTERVAL * sequence);
                liveness_ping(&mut first, sequence);
            }
            tool_done.store(true, Ordering::SeqCst);
            let output = liveness_receive_secure(&mut first, &mut secure, &config, LIVENESS_OBSERVE);
            // Delivered on the FIRST connection: the tool call cost no reconnect.
            assert_eq!(output["kind"], "event");
            assert_eq!(output["payload"]["payload"]["message"], "long tool call finished");
            let acked = output["payload"]["sourceSeq"]
                .as_u64()
                .expect("event carries its source sequence");
            send_secure(
                &mut first,
                &mut secure,
                &config,
                &control(&state, "connection_1", "ack", json!({"ackedSourceSeq": acked})),
            );
            thread::sleep(LIVENESS_SETTLE);
            assert!(!liveness_runner_closed(&first));
            // Pings stop (controller gone): the same clock closes the leg.
            liveness_assert_open_at(
                &clock,
                &first,
                LIVENESS_IDLE_PERIOD + LIVENESS_SILENCE - LIVENESS_TOLERANCE,
            );
            liveness_assert_closed_at(
                &clock,
                &mut first,
                LIVENESS_IDLE_PERIOD + LIVENESS_SILENCE + LIVENESS_TOLERANCE,
            );
            let mut second = liveness_redial(address);
            let mut secure = liveness_lease(&mut second, &config, &state, expires);
            send_secure(
                &mut second,
                &mut secure,
                &config,
                &welcome(&state, "connection_2", None, expires, acked, vec![]),
            );
            liveness_shutdown(&mut second, &mut secure, &config, &state, "connection_2", 2);
        })
    };
    let result = super::super::run_durable_runner(
        config,
        BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap(),
        LongToolCall {
            opened: false,
            emitted: false,
            tool_done,
            opens: opens.clone(),
        },
    );
    if let Err(panic) = controller.join() {
        std::panic::resume_unwind(panic);
    }
    result.unwrap();
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    let final_state = liveness_final_state(&directory);
    // The one reconnect is the post-turn silence close, not the tool call.
    assert_eq!(final_state.reconnect_count, 1);
    liveness_assert_bounded_diagnostic(&final_state);
    std::fs::remove_dir_all(directory).unwrap();
}

/// Judged rows (e) and (d), end to end through run_durable_runner in listen
/// mode: a dropped (half-open) server leg -> runnerd frees the slot within
/// 120 s -> the server's redial is admitted and authenticates -> the NEXT
/// lease_renew is sent and answered on the new connection. The reconnect does
/// not wait for T1 (the renewal deadline), which used to be the first write
/// that could notice the dead leg.
#[test]
fn inbound_liveness_dropped_server_leg_reconnects_and_renews_on_the_new_connection() {
    struct Idle;

    impl super::super::CommandExecutor for Idle {
        fn execute(
            &mut self,
            _command: &Command,
        ) -> Result<super::super::CommandExecution, DurableRunnerError> {
            Ok(super::super::CommandExecution::result(
                json!({"status": "completed"}),
            ))
        }
    }

    let (config, address, directory) = liveness_listen_config("e2e");
    let state = test_state(&config);
    let clock = test_clock::VirtualClock::new();
    clock.install();
    let controller = {
        let (config, state, clock) = (config.clone(), state.clone(), clock.clone());
        thread::spawn(move || {
            let started = current_unix_ms().unwrap();
            let expires = started + 8_000;
            let renewal_due = started + (expires - started) / 2; // T1
            let mut first = liveness_dial(address).unwrap();
            let mut secure = liveness_bootstrap(&mut first, &config, &state, expires);
            let mut greeting =
                welcome(&state, "connection_1", Some("lease-secret"), expires, 0, vec![]);
            greeting["payload"]["connectionLeaseRenewalVersion"] = json!(1);
            send_secure(&mut first, &mut secure, &config, &greeting);
            // The connected loop is live at virtual 0.
            send_secure(
                &mut first,
                &mut secure,
                &config,
                &control(&state, "connection_1", "ping", json!({})),
            );
            let pong = liveness_receive_secure(&mut first, &mut secure, &config, LIVENESS_OBSERVE);
            assert_eq!(pong["kind"], "pong");
            // The server leg drops without a FIN: hold the socket, go silent.
            clock.set(LIVENESS_SILENCE + LIVENESS_TOLERANCE);
            let mut second = liveness_redial(address);
            assert!(
                liveness_wait_for_runner_close(&mut first),
                "the dropped leg was not closed"
            );
            let mut secure = liveness_lease(&mut second, &config, &state, expires);
            let mut greeting = welcome(&state, "connection_2", None, expires, 0, vec![]);
            greeting["payload"]["connectionLeaseRenewalVersion"] = json!(1);
            send_secure(&mut second, &mut secure, &config, &greeting);
            assert!(
                current_unix_ms().unwrap() < renewal_due,
                "the new connection authenticated only after T1"
            );
            let renewal = liveness_receive_secure(
                &mut second,
                &mut secure,
                &config,
                Duration::from_secs(10),
            );
            assert_eq!(renewal["kind"], "lease_renew");
            assert_eq!(renewal["connectionId"], "connection_2");
            assert_eq!(
                renewal["payload"]["connectionLeaseExpiresAtUnixMs"],
                json!(expires)
            );
            let renewed = current_unix_ms().unwrap() + 60_000;
            send_secure(
                &mut second,
                &mut secure,
                &config,
                &control(
                    &state,
                    "connection_2",
                    "lease_renewed",
                    json!({
                        "previousExpiresAtUnixMs": expires,
                        "connectionLeaseExpiresAtUnixMs": renewed,
                        "connectionLeaseRevocationEpoch": 1,
                    }),
                ),
            );
            // Answered: runnerd is still serving after the OLD expiry.
            while current_unix_ms().unwrap() < expires + 1_000 {
                thread::sleep(Duration::from_millis(100));
            }
            liveness_shutdown(&mut second, &mut secure, &config, &state, "connection_2", 1);
        })
    };
    let result = super::super::run_durable_runner(
        config,
        BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap(),
        Idle,
    );
    if let Err(panic) = controller.join() {
        std::panic::resume_unwind(panic);
    }
    result.unwrap();
    let final_state = liveness_final_state(&directory);
    assert_eq!(final_state.reconnect_count, 1);
    liveness_assert_bounded_diagnostic(&final_state);
    std::fs::remove_dir_all(directory).unwrap();
}

/// Guard (not a judged row): the runner-DIALED transport is out of scope. The
/// server end of a runner-dialed connection (server/src/realtime/runner-prp-ws.ts)
/// sends no protocol pings, so a quiet dialed connection must not be cut.
#[test]
fn inbound_liveness_does_not_cut_a_quiet_runner_dialed_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut config = config(address.port());
    config.max_runtime = Duration::from_secs(60);
    let state = test_state(&config);
    let clock = test_clock::VirtualClock::new();
    clock.install();
    let (quiet, quiet_done) = mpsc::channel::<()>();
    let controller = {
        let (config, state) = (config.clone(), state.clone());
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = accept(stream).unwrap();
            let expires = current_unix_ms().unwrap() + 600_000;
            let mut secure = liveness_bootstrap(&mut socket, &config, &state, expires);
            send_secure(
                &mut socket,
                &mut secure,
                &config,
                &welcome(&state, "connection_1", Some("lease-secret"), expires, 0, vec![]),
            );
            quiet_done.recv_timeout(Duration::from_secs(10)).unwrap();
            send_secure(
                &mut socket,
                &mut secure,
                &config,
                &control(&state, "connection_1", "ping", json!({})),
            );
            let pong = liveness_receive_secure(&mut socket, &mut secure, &config, LIVENESS_OBSERVE);
            assert_eq!(pong["kind"], "pong");
        })
    };
    let endpoint = RunnerTransportEndpoint::new(&config.connect_url, &config.run_id).unwrap();
    let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
    let (mut transport, _) = AuthenticatedTransport::connect(
        &endpoint,
        &config,
        &state,
        Some(&ticket),
        None,
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap()
    .unwrap();
    clock.set(LIVENESS_IDLE_PERIOD);
    let quiet_until = Instant::now() + LIVENESS_SETTLE;
    while Instant::now() < quiet_until {
        assert!(transport.receive_json().unwrap().is_none());
    }
    quiet.send(()).unwrap();
    let deadline = Instant::now() + LIVENESS_OBSERVE;
    let ping = loop {
        assert!(Instant::now() < deadline, "controller ping never arrived");
        if let Some(message) = transport.receive_json().unwrap() {
            break message;
        }
    };
    assert_eq!(ping["kind"], "ping");
    transport
        .send_json(&json!({"kind": "pong"}))
        .unwrap();
    if let Err(panic) = controller.join() {
        std::panic::resume_unwind(panic);
    }
}
