//! Trust-boundary regression: actual app-server frames through the native executor.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

struct PiParkFixture {
    directory: PathBuf,
    executor: NativeProviderCommandExecutor,
    thread_id: String,
    turn_id: String,
}

impl PiParkFixture {
    fn new(hold_turn: bool) -> Self {
        let directory = temporary_directory("pi-park-readiness");
        let mut config = opencode_config(&directory);
        let relay = directory.join("pi-park-relay.py");
        // A controlled Pi facade peer. It transparently forwards the existing
        // fake app-server and lets each test add exact frames on that same stdout.
        fs::write(
            &relay,
            r#"
import json, socket, subprocess, sys, threading
root, fake, hold = sys.argv[1:]
lock = threading.Lock()
server = socket.socket(socket.AF_UNIX)
server.bind(root + '/park.sock')
server.listen()
p = subprocess.Popen([fake, '--state-file', root + '/fake-opencode-state.json',
    '--call-log', root + '/fake-opencode-calls.log', '--require-completion-contract']
    + (['--hold-turn'] if hold == 'yes' else []), stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, text=True, bufsize=1)
def emit(line):
    with lock:
        sys.stdout.write(line)
        sys.stdout.flush()
def inputs():
    for line in sys.stdin:
        p.stdin.write(line)
        p.stdin.flush()
    p.stdin.close()
def inject():
    while True:
        conn, _ = server.accept()
        with conn:
            line = conn.makefile('r').readline()
            for frame in json.loads(line):
                emit((frame if isinstance(frame, str) else json.dumps(frame)) + '\n')
            conn.sendall(b'ok\n')
threading.Thread(target=inputs, daemon=True).start()
threading.Thread(target=inject, daemon=True).start()
for line in p.stdout:
    emit(line)
"#,
        )
        .unwrap();
        let proxy = directory.join("qualified-opencode-proxy-script");
        fs::set_permissions(&proxy, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            &proxy,
            format!(
                "#!/bin/sh\nexec /usr/bin/python3 '{}' '{}' '{}' '{}'\n",
                relay.display(),
                directory.display(),
                env!("CARGO_BIN_EXE_fake-codex-app-server"),
                if hold_turn { "yes" } else { "no" },
            ),
        )
        .unwrap();
        fs::set_permissions(&proxy, fs::Permissions::from_mode(0o500)).unwrap();
        config
            .opencode_launch_profile
            .as_mut()
            .unwrap()
            .proxy_script = qualified_artifact(proxy);
        config.pi_launch_profile = config.opencode_launch_profile.take();
        let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        executor
            .execute(&command(
                1,
                "run.prepare",
                pi_rpc_prepare_payload(&directory),
            ))
            .unwrap();
        executor
            .execute(&command(2, "session.open", json!({})))
            .unwrap();
        acknowledge_delivered_events(&mut executor);
        let started = executor
            .execute(&command(
                3,
                "turn.start",
                json!({"text":"Complete this turn."}),
            ))
            .unwrap();
        let turn_id = started.result["providerTurnId"]
            .as_str()
            .unwrap()
            .to_owned();
        if !hold_turn {
            poll_opencode_until(&mut executor, "turn.completed");
        }
        acknowledge_delivered_events(&mut executor);
        let state: Value =
            serde_json::from_slice(&fs::read(directory.join("codex-provider-state.json")).unwrap())
                .unwrap();
        Self {
            directory,
            executor,
            thread_id: state["threadId"].as_str().unwrap().to_owned(),
            turn_id,
        }
    }

    fn report(&self, ready: Value, reasons: Value) -> Value {
        json!({"method":"paperclip/parkReady", "params":{
            "schema":"paperclip.pi.park-ready.v1", "threadId":self.thread_id,
            "turnId":self.turn_id, "ready":ready, "reasons":reasons,
        }})
    }

    fn inject(&mut self, frames: Vec<Value>) {
        let mut stream = UnixStream::connect(self.directory.join("park.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        writeln!(stream, "{}", serde_json::to_string(&frames).unwrap()).unwrap();
        let mut ack = String::new();
        BufReader::new(stream).read_line(&mut ack).unwrap();
        assert_eq!(ack, "ok\n");
        // host_park_ready's existing bounded tail drain also covers frames that
        // have not yet reached the supervised stdout reader's queue.
    }

    fn ready(&mut self) -> bool {
        acknowledge_delivered_events(&mut self.executor);
        self.executor.host_park_ready().unwrap()
    }
}

impl Drop for PiParkFixture {
    fn drop(&mut self) {
        self.executor.shutdown().unwrap();
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn pi_rpc_park_requires_a_proxy_report() {
    let mut f = PiParkFixture::new(false);
    assert!(
        !f.ready(),
        "native settlement cannot enumerate Pi children or goals"
    );
}

#[test]
fn pi_rpc_park_all_clear_with_proxy_ready() {
    let mut f = PiParkFixture::new(false);
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
}

#[test]
fn pi_rpc_park_rejects_an_active_turn_even_with_proxy_ready() {
    let mut f = PiParkFixture::new(true);
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(!f.ready());
}

#[test]
fn pi_rpc_park_rejects_a_tool_in_flight_even_with_proxy_ready() {
    let mut f = PiParkFixture::new(false);
    f.inject(vec![
        json!({"method":"item/started", "params":{
            "threadId":f.thread_id, "turnId":f.turn_id,
            "item":{"id":"native-tool", "type":"builtinToolCall", "status":"inProgress"}
        }}),
        f.report(json!(true), json!([])),
    ]);
    assert!(!f.ready());
    f.inject(vec![
        json!({"method":"item/completed", "params":{
            "threadId":f.thread_id, "turnId":f.turn_id,
            "item":{"id":"native-tool", "type":"builtinToolCall", "status":"completed"}
        }}),
        f.report(json!(true), json!([])),
    ]);
    assert!(
        f.ready(),
        "completed native tool plus fresh report unblocks park"
    );
}

#[test]
fn pi_rpc_park_post_terminal_request_revokes_the_previous_report() {
    let mut f = PiParkFixture::new(false);
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
    f.inject(vec![json!({"id":"pi-dialog", "method":"item/tool/requestUserInput", "params":{
        "threadId":f.thread_id, "turnId":f.turn_id,
        "questions":[{"id":"approval", "header":"Approval", "question":"Proceed?", "options":[]}]
    }})]);
    // The generic facade rejects this request; its arrival still revokes the
    // earlier report. A new report is needed after the proxy drains its waiter.
    assert!(!f.ready());
}

macro_rules! blocked_report {
    ($name:ident, $reason:literal) => {
        #[test]
        fn $name() {
            let mut f = PiParkFixture::new(false);
            f.inject(vec![f.report(json!(false), json!([$reason]))]);
            assert!(!f.ready());
        }
    };
}
blocked_report!(pi_rpc_park_rejects_pending_dialog, "pending_dialog");
blocked_report!(pi_rpc_park_rejects_queued_input, "queued_input");
blocked_report!(
    pi_rpc_park_rejects_pending_credential_frame,
    "pending_credentials"
);
blocked_report!(pi_rpc_park_rejects_proxy_children, "children_active");
blocked_report!(pi_rpc_park_rejects_proxy_goal, "goal_active");
blocked_report!(pi_rpc_park_rejects_proxy_unknown, "readiness_unknown");

#[test]
fn pi_rpc_park_late_event_revokes_the_previous_report_until_requalified() {
    let mut f = PiParkFixture::new(false);
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
    f.inject(vec![json!({"method":"item/agentMessage/delta", "params":{
        "threadId":f.thread_id, "turnId":f.turn_id, "delta":"late output"
    }})]);
    assert!(
        !f.ready(),
        "late events must invalidate the previously qualified cut"
    );
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
}

#[test]
fn pi_rpc_park_rejects_malformed_stale_and_unbound_reports() {
    let mut f = PiParkFixture::new(false);
    for mutation in ["schema", "threadId", "turnId", "ready", "reasons", "extra"] {
        f.inject(vec![f.report(json!(true), json!([]))]);
        assert!(f.ready());
        let mut invalid = f.report(json!(true), json!([]));
        match mutation {
            "ready" => invalid["params"]["ready"] = json!("true"),
            "reasons" => invalid["params"]["reasons"] = json!(["children_active"]),
            "extra" => invalid["params"]["extra"] = json!(true),
            field => invalid["params"][field] = json!("wrong"),
        }
        f.inject(vec![invalid]);
        assert!(!f.ready(), "invalid {mutation} must revoke readiness");
    }
}

#[test]
fn pi_rpc_park_does_not_change_opencode_eligibility() {
    let directory = temporary_directory("opencode-park-unchanged");
    let config = opencode_config(&directory);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    executor
        .execute(&command(
            1,
            "run.prepare",
            opencode_prepare_payload(&directory),
        ))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text":"Complete this turn."}),
        ))
        .unwrap();
    poll_opencode_until(&mut executor, "turn.completed");
    acknowledge_delivered_events(&mut executor);
    assert!(
        !executor.host_park_ready().unwrap(),
        "OpenCode remains outside the native park pair"
    );
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn pi_rpc_park_malformed_late_bytes_revoke_readiness() {
    let mut f = PiParkFixture::new(false);
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
    f.inject(vec![json!("{not-json")]);
    assert!(f.executor.host_park_ready().is_err());
    assert!(
        !f.ready(),
        "a consumed malformed frame cannot leave cached readiness"
    );
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
}

#[test]
fn pi_rpc_park_does_not_reuse_a_previous_turn_report() {
    let mut f = PiParkFixture::new(false);
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
    let old_report = f.report(json!(true), json!([]));
    let started = f
        .executor
        .execute(&command(4, "turn.start", json!({"text":"Next turn."})))
        .unwrap();
    f.turn_id = started.result["providerTurnId"]
        .as_str()
        .unwrap()
        .to_owned();
    poll_opencode_until(&mut f.executor, "turn.completed");
    assert!(!f.ready());
    f.inject(vec![old_report]);
    assert!(!f.ready());
    f.inject(vec![f.report(json!(true), json!([]))]);
    assert!(f.ready());
}
