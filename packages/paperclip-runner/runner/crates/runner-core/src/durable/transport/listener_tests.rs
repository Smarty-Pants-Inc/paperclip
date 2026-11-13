//! Real loopback regression coverage for the stale ingress backlog incident.
use super::*;

const CLIENT_BUDGET: Duration = Duration::from_millis(1500);

fn endpoint() -> (RunnerTransportEndpoint, SocketAddr, String) {
    loop {
        let reservation = TcpListener::bind("0.0.0.0:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let path = "/api/runner/v1/connect/run_1".to_owned();
        if let Ok(endpoint) =
            RunnerTransportEndpoint::new(&format!("listen://0.0.0.0:{port}{path}"), "run_1")
        {
            return (endpoint, ([127, 0, 0, 1], port).into(), path);
        }
    }
}

fn stale_peers(address: SocketAddr, partial: bool) -> Vec<TcpStream> {
    (0..8)
        .map(|_| {
            let mut stream = TcpStream::connect(address).unwrap();
            if partial {
                stream
                    .write_all(b"GET /api/runner/v1/connect/run_1 HTTP/1.1\r\nHost:")
                    .unwrap();
            }
            stream
        })
        .collect()
}

fn upgrade(
    endpoint: &RunnerTransportEndpoint,
    address: SocketAddr,
    path: String,
) -> (RunnerSocket, WebSocket<TcpStream>) {
    let started = Instant::now();
    let client = thread::spawn(move || {
        let stream = TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(CLIENT_BUDGET)).unwrap();
        stream.set_write_timeout(Some(CLIENT_BUDGET)).unwrap();
        tungstenite::client(format!("ws://{address}{path}"), stream)
    });
    let deadline = started + Duration::from_secs(10);
    let mut accepted = None;
    let mut failure = None;
    while started.elapsed() < CLIENT_BUDGET {
        match endpoint.open(1024 * 1024, None, deadline) {
            Ok(Some(socket)) => {
                accepted = Some(socket);
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    let result = client.join().unwrap();
    eprintln!(
        "upgrade elapsed_ms={} accepted={} client_ok={} failure={failure:?}",
        started.elapsed().as_millis(),
        accepted.is_some(),
        result.is_ok()
    );
    assert!(
        started.elapsed() < CLIENT_BUDGET,
        "valid peer delayed by stale backlog"
    );
    assert!(
        failure.is_none(),
        "stale peer failed the controller connect: {failure:?}"
    );
    (
        accepted.expect("no controller socket delivered"),
        result.expect("client upgrade failed").0,
    )
}

#[test]
fn ingress_silent_backlog_does_not_block_controller() {
    let (endpoint, address, path) = endpoint();
    assert!(endpoint
        .open(1024 * 1024, None, Instant::now() + Duration::from_secs(10))
        .unwrap()
        .is_none());
    let _stale = stale_peers(address, false);
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

#[test]
fn ingress_partial_http_backlog_does_not_block_controller() {
    let (endpoint, address, path) = endpoint();
    assert!(endpoint
        .open(1024 * 1024, None, Instant::now() + Duration::from_secs(10))
        .unwrap()
        .is_none());
    let _stale = stale_peers(address, true);
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

#[test]
fn ingress_idle_backlog_does_not_delay_next_connect() {
    let (endpoint, address, path) = endpoint();
    let _stale = stale_peers(address, true);
    // No open/connect call while these peers arrive: runnerd is idle.
    thread::sleep(Duration::from_millis(100));
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

#[test]
fn ingress_second_controller_is_rejected_promptly() {
    let (endpoint, address, path) = endpoint();
    let (_controller, _peer) = upgrade(&endpoint, address, path.clone());
    let started = Instant::now();
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(CLIENT_BUDGET)).unwrap();
    let result = tungstenite::client(format!("ws://{address}{path}"), stream);
    eprintln!(
        "second controller elapsed_ms={} result={result:?}",
        started.elapsed().as_millis()
    );
    match result {
        Err(HandshakeError::Failure(tungstenite::Error::Http(response))) => {
            assert!(matches!(response.status().as_u16(), 409 | 503));
        }
        other => panic!("second controller must receive prompt HTTP rejection: {other:?}"),
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(_controller);
    drop(_peer);
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

fn assert_closed(stream: &mut TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut byte = [0];
    match stream.read(&mut byte) {
        Ok(0) => {}
        Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
        other => panic!("expired ingress connection was not closed: {other:?}"),
    }
}

#[test]
fn ingress_silent_and_partial_peers_expire_without_connecting() {
    let (endpoint, address, path) = endpoint();
    let mut silent = TcpStream::connect(address).unwrap();
    let mut partial = TcpStream::connect(address).unwrap();
    partial.write_all(b"GET / HTTP/1.1\r\nHost:").unwrap();
    let started = Instant::now();
    assert_closed(&mut silent);
    assert_closed(&mut partial);
    eprintln!(
        "independent handshake deadlines closed both peers in {}ms",
        started.elapsed().as_millis()
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

#[test]
fn ingress_idle_upgrade_has_bounded_grace_and_retry_succeeds() {
    let (endpoint, address, path) = endpoint();
    // Upgrade without ever calling open: accept and handshake must be always-on.
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(CLIENT_BUDGET)).unwrap();
    let (mut peer, _) = tungstenite::client(format!("ws://{address}{path}"), stream).unwrap();
    let started = Instant::now();
    assert_closed(peer.get_mut());
    eprintln!(
        "idle ready socket closed at {}ms grace",
        started.elapsed().as_millis()
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

#[test]
fn ingress_pending_budget_is_bounded_and_recovers_after_deadlines() {
    let (endpoint, address, path) = endpoint();
    let mut stale: Vec<_> = (0..16)
        .map(|_| TcpStream::connect(address).unwrap())
        .collect();
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(CLIENT_BUDGET)).unwrap();
    let started = Instant::now();
    let result = tungstenite::client(format!("ws://{address}{path}"), stream);
    assert!(matches!(result,
        Err(HandshakeError::Failure(tungstenite::Error::Http(response)))
            if response.status().as_u16() == 503));
    assert!(started.elapsed() < Duration::from_secs(1));
    for stream in &mut stale {
        assert_closed(stream);
    }
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

#[test]
fn ingress_path_query_and_extension_checks_are_unchanged() {
    let (endpoint, address, path) = endpoint();
    for (suffix, extension) in [("/wrong", false), ("?query=1", false), ("", true)] {
        let stream = TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(CLIENT_BUDGET)).unwrap();
        let mut request = format!("ws://{address}{path}{suffix}")
            .into_client_request()
            .unwrap();
        if extension {
            request.headers_mut().insert(
                "sec-websocket-extensions",
                "permessage-deflate".parse().unwrap(),
            );
        }
        let result = tungstenite::client(request, stream);
        assert!(matches!(result,
            Err(HandshakeError::Failure(tungstenite::Error::Http(response)))
                if response.status().as_u16() == 400));
    }
    let (_controller, _peer) = upgrade(&endpoint, address, path);
}

#[test]
fn ingress_rotation_discards_old_ready_and_partial_connections() {
    let (mut endpoint, address, path) = endpoint();
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(CLIENT_BUDGET)).unwrap();
    let (mut old, _) = tungstenite::client(format!("ws://{address}{path}"), stream).unwrap();
    let mut partial = TcpStream::connect(address).unwrap();
    partial
        .write_all(format!("GET {path} HTTP/1.1\r\nHost:").as_bytes())
        .unwrap();
    let next_path = "/api/runner/v1/connect/run_2".to_owned();
    endpoint
        .rotate(
            &format!("listen://0.0.0.0:{}{next_path}", address.port()),
            "run_2",
        )
        .unwrap();
    assert_closed(old.get_mut());
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(CLIENT_BUDGET)).unwrap();
    let old_result = tungstenite::client(format!("ws://{address}{path}"), stream);
    assert!(matches!(old_result,
        Err(HandshakeError::Failure(tungstenite::Error::Http(response)))
            if response.status().as_u16() == 400));
    let (_controller, _peer) = upgrade(&endpoint, address, next_path);
}

#[test]
fn ingress_shutdown_cancels_pending_handshakes_and_releases_port() {
    let (endpoint, address, _path) = endpoint();
    let mut stale = stale_peers(address, true);
    let started = Instant::now();
    drop(endpoint);
    assert!(started.elapsed() < Duration::from_secs(1));
    for stream in &mut stale {
        assert_closed(stream);
    }
    let _rebound = TcpListener::bind(("0.0.0.0", address.port())).unwrap();
}
