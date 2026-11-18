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
