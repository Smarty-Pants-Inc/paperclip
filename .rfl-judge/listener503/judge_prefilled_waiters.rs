// Literal acceptance order: flood valid unauthenticated waiters first, then a real
// reconnect, then release the live controller. Keep attempting real PRP auth as
// runnerd would; do not merely leave the ready slot idle to manufacture starvation.
#[test]
fn independent_prefilled_unauthenticated_waiters_do_not_starve_real_reconnect() {
    let mut failed = 0;
    for trial in 0..3 {
        let (endpoint, address) = judge_endpoint();
        let a = judge_peer(address, "A");
        let mut active = judge_auth(&endpoint, address, Duration::from_secs(3)).unwrap();
        assert_eq!(judge_frame(&mut active)["peer"], "A");
        let mut attackers = Vec::new();
        for _ in 0..15 {
            attackers.push(judge_raw_request(address, "/api/runner/v1/connect/run_1"));
            thread::sleep(Duration::from_millis(3));
        }
        let b = judge_peer(address, "B");
        let start = Instant::now();
        assert!(b.upgraded.recv_timeout(Duration::from_millis(100)).is_err());
        a.commands.send(Some(1)).unwrap();
        assert_eq!(judge_frame(&mut active)["tick"], 1);
        drop(active);
        judge_stop(a).unwrap();
        let mut auth_failures = 0;
        let mut admitted = false;
        let mut refusal = None;
        while start.elapsed() < Duration::from_secs(17) {
            match judge_auth(&endpoint, address, Duration::from_millis(2600)) {
                Ok(mut live) => {
                    assert_eq!(judge_frame(&mut live)["peer"], "B");
                    admitted = true;
                    break;
                }
                Err(_) => auth_failures += 1,
            }
            if let Ok(Err(message)) = b.upgraded.try_recv() {
                refusal = Some(message);
                break;
            }
        }
        drop(endpoint);
        drop(attackers);
        let b_result = judge_stop(b);
        if !admitted { failed += 1; }
        eprintln!("JUDGE prefilled trial={trial} real_B_admitted={admitted} elapsed_ms={} bad_auth_attempts={auth_failures} refusal={refusal:?} peer={b_result:?}", start.elapsed().as_millis());
    }
    assert_eq!(failed, 0, "credential-free waiting upgrades starved a legitimate reconnect even while runnerd attempted authentication");
}
