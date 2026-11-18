use super::*;

// Keep: data safety at the provider/durable-state boundary. A real post-terminal
// frame makes the production drain fail; a unit mock would miss the lost terminal.
fn tail_drain_fixture(label: &str) -> (PathBuf, PathBuf, CodexCommandExecutor) {
    let directory = temporary_directory(label);
    let gate = directory.join("release-unsafe-tail");
    let config = provider_config(
        &directory,
        &[
            "--durable-turn-ids",
            "--emit-post-completion-foreign-turn",
            "--post-completion-notification-gate",
            gate.to_str().unwrap(),
        ],
    );
    let executor = start_tail_executor(&directory, config);
    (directory, gate, executor)
}

fn start_tail_executor(directory: &Path, config: CodexProviderConfig) -> CodexCommandExecutor {
    let runner_config = durable_config(directory);
    let mut executor = CodexCommandExecutor::with_runner_config(directory, &runner_config);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
                "completionContract": {"revision": "tail-drain-contract", "criterionIds": ["output"]},
            }),
        ))
        .unwrap();
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Persist this completion even if its tail is unsafe."}),
        ))
        .unwrap();
    executor
}

fn release_unsafe_tail(gate: &Path) {
    fs::write(gate, b"release").unwrap();
    let emitted = gate.with_extension("emitted");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !emitted.exists() {
        assert!(std::time::Instant::now() < deadline, "tail was not emitted");
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn saved_tail_state(directory: &Path) -> Value {
    serde_json::from_slice(&fs::read(directory.join("codex-provider-state.json")).unwrap()).unwrap()
}

fn assert_tail_diagnostic(events: &[PolledEvent], cause: &str) {
    let diagnostic = events
        .iter()
        .find(|event| {
            event.event_type == "harness.diagnostic"
                && event.payload["code"] == "provider_completed_tail_drain_failed"
        })
        .expect("the run must retain the drain error as a diagnostic");
    assert_eq!(diagnostic.payload["severity"], "warning");
    assert!(diagnostic.payload["message"]
        .as_str()
        .unwrap()
        .contains(cause));
}

#[test]
fn terminal_tail_drain_error_preserves_terminal_and_poll_loop() {
    let (directory, gate, mut executor) = tail_drain_fixture("terminal-tail-drain-error");
    // No polling before the acknowledgement: both terminal and offending frame
    // are available to the production poll/drain path, without a timing race.
    release_unsafe_tail(&gate);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let events = loop {
        assert!(std::time::Instant::now() < deadline);
        let events = executor
            .poll_events()
            .expect("tail drain error must not escape the runner poll loop");
        if events
            .iter()
            .any(|event| event.event_type == "run.terminal")
        {
            break events;
        }
        executor.acknowledge_events(events.len()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    assert_tail_diagnostic(&events, "unsafe post-terminal provider method turn/started");
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type == "turn.completed")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type == "run.terminal")
            .count(),
        1
    );
    let saved = saved_tail_state(&directory);
    assert_eq!(saved["activeProviderTurnId"], Value::Null);
    assert_eq!(saved["lifecycle"], "reconciliation_required");
    assert_eq!(saved["completedTurnAuthoritative"], true);
    let pending: Vec<PolledEvent> = serde_json::from_value(saved["pendingEvents"].clone()).unwrap();
    assert_eq!(
        pending, events,
        "terminal and diagnostic must be on disk before delivery"
    );
    assert_eq!(
        executor.poll_events().unwrap(),
        events,
        "unacknowledged evidence replays"
    );
    executor.acknowledge_events(events.len()).unwrap();
    for _ in 0..2 {
        executor
            .poll_events()
            .expect("the poll loop stays alive after terminal delivery");
    }
    executor
        .execute(&command("snapshot", 4, "session.snapshot", json!({})))
        .expect("the runner can still serve commands after the drain failure");
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn host_park_tail_drain_error_is_diagnostic_and_not_process_fatal() {
    let (directory, gate, mut executor) = tail_drain_fixture("park-tail-drain-error");
    wait_for_executor_event_batch(&mut executor, "run.terminal");
    assert!(
        executor.host_park_ready().unwrap(),
        "settled provider is initially parkable"
    );
    let before = saved_tail_state(&directory);
    release_unsafe_tail(&gate);
    assert!(!executor
        .host_park_ready()
        .expect("tail drain failure must refuse parking, not exit runnerd"));
    let saved = saved_tail_state(&directory);
    assert_eq!(saved["activeProviderTurnId"], Value::Null);
    assert_eq!(saved["lifecycle"], "reconciliation_required");
    assert_eq!(
        saved["completedProviderTurnId"],
        before["completedProviderTurnId"]
    );
    assert_eq!(saved["completedTurnAuthoritative"], true);
    let pending: Vec<PolledEvent> = serde_json::from_value(saved["pendingEvents"].clone()).unwrap();
    assert_tail_diagnostic(
        &pending,
        "unsafe post-terminal provider method turn/started",
    );
    let events = executor
        .poll_events()
        .expect("polling continues after a failed park probe");
    assert_eq!(events, pending);
    executor.acknowledge_events(events.len()).unwrap();
    assert!(
        !executor.host_park_ready().unwrap(),
        "unsafe session must stay fenced"
    );
    executor.poll_events().unwrap();
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn terminal_tail_poll_error_preserves_terminal_and_next_poll() {
    let directory = temporary_directory("terminal-tail-poll-error");
    let gate = directory.join("release-invalid-tail");
    let mut config = provider_config(&directory, &[]);
    config.command = PathBuf::from("/bin/sh");
    config.args = vec![
        "-c".to_owned(),
        r#"
while IFS= read -r line; do
  id=${line#*\"id\":}
  id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/start"'*) printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id" ;;
    *'"method":"thread/goal/get"'*)
      printf '{"id":%s,"result":{"goal":null}}\n' "$id"
      if [ -f "$1" ]; then printf '%s\n' 'invalid JSON-RPC in terminal tail'; fi ;;
    *'"method":"turn/start"'*)
      printf '{"id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
      printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}'
      while [ ! -f "$1" ]; do sleep 0.001; done
      printf emitted > "$2" ;;
  esac
done
"#
        .to_owned(),
        "tail-fixture".to_owned(),
        gate.to_string_lossy().into_owned(),
        gate.with_extension("emitted").to_string_lossy().into_owned(),
    ];
    let mut executor = start_tail_executor(&directory, config);
    // Arm the invalid frame after the goal-read response, so it reaches the
    // tail drain rather than being consumed by terminal goal reconciliation.
    release_unsafe_tail(&gate);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let events = loop {
        assert!(std::time::Instant::now() < deadline);
        let events = executor
            .poll_events()
            .expect("tail poll error is run-local");
        if events
            .iter()
            .any(|event| event.event_type == "run.terminal")
        {
            break events;
        }
        executor.acknowledge_events(events.len()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    assert_tail_diagnostic(&events, "invalid JSON-RPC");
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type == "run.terminal")
            .count(),
        1
    );
    let saved = saved_tail_state(&directory);
    assert_eq!(saved["lifecycle"], "reconciliation_required");
    assert_eq!(saved["activeProviderTurnId"], Value::Null);
    let pending: Vec<PolledEvent> = serde_json::from_value(saved["pendingEvents"].clone()).unwrap();
    assert_eq!(pending, events);
    // A poll error must not leave the same broken provider reader live, ready
    // to escape on a later iteration after the completed terminal was emitted.
    executor.acknowledge_events(events.len()).unwrap();
    for _ in 0..3 {
        assert!(executor.poll_events().unwrap().is_empty());
    }
    assert!(!executor.provider_poll_is_live());
    assert!(!executor.host_park_ready().unwrap());
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

// Keep: P1c5g. A suspended box that resumes (slow thaw) delivers the settled
// turn's tail as a paced burst longer than the warm-attach drain's 100 ms
// clock. That must not mark the settled session reconciliation_required, which
// forces a replacement provider thread (a fork) on the next run.
fn settled_burst_executor(
    label: &str,
    unsafe_at: Option<usize>,
) -> (PathBuf, PathBuf, CodexCommandExecutor) {
    let directory = temporary_directory(label);
    let gate = directory.join("release-settled-tail-burst");
    let mut switches = vec![
        "--durable-turn-ids".to_owned(),
        "--settled-tail-burst-gate".to_owned(),
        gate.to_str().unwrap().to_owned(),
        "--settled-tail-burst-frames".to_owned(),
        "120".to_owned(),
        "--settled-tail-burst-interval-ms".to_owned(),
        "2".to_owned(),
    ];
    if let Some(index) = unsafe_at {
        switches.push("--settled-tail-burst-turn-started-at".to_owned());
        switches.push(index.to_string());
    }
    let switches = switches.iter().map(String::as_str).collect::<Vec<_>>();
    let config = provider_config(&directory, &switches);
    // A warm (kept) provider: no completion contract, so the settled process
    // stays live for the next run's in-place attachment.
    let runner_config = durable_config(&directory);
    let mut executor = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({"provider": config, "authorizedTools": task_context_tool_set()}),
        ))
        .unwrap();
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Settle, then the box is suspended."}),
        ))
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "first turn must settle"
        );
        let events = poll_and_ack(&mut executor).unwrap();
        if events
            .iter()
            .any(|event| event.event_type == "turn.completed")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let settled = saved_tail_state(&directory);
    assert_eq!(settled["activeProviderTurnId"], Value::Null);
    assert_ne!(settled["lifecycle"], "reconciliation_required");
    // Resume: the box thaws and the settled tail starts arriving.
    fs::write(&gate, b"release").unwrap();
    let started = gate.with_extension("started");
    while !started.exists() {
        assert!(std::time::Instant::now() < deadline, "burst did not start");
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    (directory, gate, executor)
}

fn attach_during_burst(
    executor: &mut CodexCommandExecutor,
) -> Result<paperclip_runner_core::durable::CommandExecution, DurableRunnerError> {
    executor.execute(&command(
        "attach",
        5,
        "run.attach",
        json!({"authorizedTools": task_context_tool_set()}),
    ))
}

#[test]
fn warm_attach_survives_a_settled_tail_burst_longer_than_the_drain_clock() {
    let (directory, gate, mut executor) = settled_burst_executor("settled-tail-burst-attach", None);
    let before = saved_tail_state(&directory);
    let started = std::time::Instant::now();
    let attached = attach_during_burst(&mut executor);
    let elapsed = started.elapsed();
    let saved = saved_tail_state(&directory);
    eprintln!(
        "settled burst attach: elapsed={elapsed:?} ok={} lifecycle={}",
        attached.is_ok(),
        saved["lifecycle"]
    );
    let attached = attached.expect("a settled-turn tail burst is history, not new work");
    assert!(
        elapsed > std::time::Duration::from_millis(100),
        "the burst must outlast the 100 ms drain clock to prove anything ({elapsed:?})"
    );
    assert!(attached
        .events
        .iter()
        .any(|(event_type, _, _)| event_type == "run.attached"));
    assert_ne!(saved["lifecycle"], "reconciliation_required");
    assert_eq!(saved["threadId"], before["threadId"], "no fork");
    assert!(
        gate.with_extension("emitted").exists(),
        "attach waited out the burst"
    );
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn warm_attach_still_fails_closed_on_turn_started_inside_a_settled_tail_burst() {
    let (directory, _gate, mut executor) =
        settled_burst_executor("settled-tail-burst-unsafe", Some(60));
    let error =
        attach_during_burst(&mut executor).expect_err("a new turn inside the burst is live work");
    assert!(
        error
            .to_string()
            .contains("unsafe post-terminal provider method turn/started"),
        "unexpected attachment error: {error}"
    );
    assert_eq!(
        saved_tail_state(&directory)["lifecycle"],
        "reconciliation_required"
    );
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}
