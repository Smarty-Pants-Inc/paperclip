// Independent pressure checks using the authenticated peer helpers in judge_listener.rs.
fn independent_cancel_many_waiters(rotate: bool) {
    let (mut endpoint, address) = judge_endpoint();
    let a = judge_peer(address, "A");
    let mut active = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
    assert_eq!(judge_frame(&mut active)["peer"], "A");
    let mut pending: Vec<_> = (0..15).map(|_| {
        judge_raw_request(address, "/api/runner/v1/connect/run_1")
    }).collect();
    thread::sleep(Duration::from_millis(100));
    for peer in &mut pending {
        peer.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
        let mut byte = [0];
        assert!(matches!(peer.read(&mut byte), Err(e) if matches!(e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)), "waiter completed before A release");
    }
    a.commands.send(Some(1)).unwrap();
    assert_eq!(judge_frame(&mut active)["tick"], 1);
    let start = Instant::now();
    let mut endpoint = Some(endpoint);
    if rotate {
        if let RunnerTransportEndpoint::Listen { listener, path } = endpoint.as_mut().unwrap() {
            *path = "/api/runner/v1/connect/run_2".into();
            listener.rotate(path.clone());
        } else { unreachable!(); }
    } else {
        drop(endpoint.take());
    }
    for peer in &mut pending {
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut bytes = [0; 1024];
        match peer.read(&mut bytes) {
            Ok(0) => {},
            Ok(count) => assert!(bytes[..count].starts_with(b"HTTP/1.1 503")),
            Err(e) if e.kind() == io::ErrorKind::ConnectionReset => {},
            other => panic!("waiter not cancelled: {other:?}"),
        }
    }
    assert!(start.elapsed() < Duration::from_secs(1));
    if rotate {
        // Old-path attempts are rejected before queue admission, even while A remains live.
        for _ in 0..32 {
            let mut stale = judge_raw_request(address, "/api/runner/v1/connect/run_1");
            stale.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            let mut bytes = [0; 1024];
            let count = stale.read(&mut bytes).unwrap();
            assert!(bytes[..count].starts_with(b"HTTP/1.1 400"));
        }
        let mut fresh = judge_raw_request(address, "/api/runner/v1/connect/run_2");
        fresh.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let mut bytes = [0; 1024];
        assert!(matches!(fresh.read(&mut bytes), Err(e) if matches!(e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)));
        a.commands.send(Some(2)).unwrap();
        assert_eq!(judge_frame(&mut active)["tick"], 2);
        drop(active);
        judge_stop(a).unwrap();
        fresh.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let count = fresh.read(&mut bytes).unwrap();
        assert!(bytes[..count].starts_with(b"HTTP/1.1 101"));
        let endpoint = endpoint.unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(socket) = endpoint.open(65536, None, deadline).unwrap() {
                drop(socket);
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
    } else {
        drop(active);
        judge_stop(a).unwrap();
    }
    eprintln!("JUDGE lifecycle: rotate={rotate}, 15 waiters cancelled promptly; stale path checks={}",
        if rotate { 32 } else { 0 });
}

#[test]
fn independent_shutdown_joins_fifteen_waiters() { independent_cancel_many_waiters(false); }
#[test]
fn independent_rotation_cancels_fifteen_waiters_and_rejects_stale_paths() {
    independent_cancel_many_waiters(true);
}
