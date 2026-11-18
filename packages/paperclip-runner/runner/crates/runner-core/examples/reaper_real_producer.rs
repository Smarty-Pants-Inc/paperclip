//! Test producer for the sandbox Runner port-holder reaper (B1 fence b).
//!
//! It produces a Runner's on-disk state and process topology through the
//! production code, not by hand: `DurableStateStore` writes runner-state.json,
//! `process_lineage::enable_journal` is called before any provider exactly as
//! `paperclip-runnerd` does (bin/paperclip-runnerd.rs), and every provider is a
//! real `SupervisedProcess::spawn`, which starts it in its own process group
//! and journals that group under `<state-dir>/process-lineage/`.
//!
//! `--provider-script` (repeatable) is each provider's `sh -c` body; the default
//! ignores TERM. Prints `ready <pid> <pid>...` once every provider runs.
use std::{path::PathBuf, time::Duration};

use paperclip_runner_core::durable::{DurableRunnerConfig, DurableStateStore};
use paperclip_runner_core::process_supervisor::SupervisedProcess;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let value = |key: &str| {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].clone())
            .unwrap_or_else(|| panic!("missing {key}"))
    };
    let mut scripts: Vec<String> = args
        .windows(2)
        .filter(|pair| pair[0] == "--provider-script")
        .map(|pair| pair[1].clone())
        .collect();
    if scripts.is_empty() {
        scripts.push("trap '' TERM; while :; do sleep 1; done".into());
    }
    let config = DurableRunnerConfig {
        connect_url: "ws://127.0.0.1:1".into(),
        ca_bundle_path: None,
        state_dir: PathBuf::from(value("--state-dir")),
        runner_instance_id: value("--runner-id"),
        environment_lease_id: "producer-lease".into(),
        run_id: value("--run-id"),
        normalized_session_id: "producer-session".into(),
        turn_id: "producer-turn".into(),
        item_id: "producer-item".into(),
        runner_version: "producer".into(),
        runner_digest: format!("sha256:{}", "a".repeat(64)),
        acpx_launch_profile: None,
        pi_launch_profile: None,
        opencode_launch_profile: None,
        cursor_cloud_launch_profile: None,
        max_outbox_bytes: 1_048_576,
        p0_reserve_bytes: 65_536,
        max_frame_bytes: 1_048_576,
        reconnect_delay: Duration::from_millis(20),
        reconnect_grace: Some(Duration::from_secs(60)),
        max_runtime: Duration::ZERO,
        turn_scoped: false,
    };
    let store = DurableStateStore::new(&config.state_dir)?;
    let (state, _) = store.load_or_create(&config)?;
    store.save(&state)?;
    // As paperclip-runnerd: journal every provider's lineage before any starts.
    paperclip_runner_core::process_lineage::enable_journal(&config.state_dir)?;
    let mut children = Vec::new();
    for script in scripts {
        children.push(SupervisedProcess::spawn(
            std::path::Path::new("/bin/sh"),
            &["-c".into(), script],
            Duration::from_millis(100),
            65_536,
        )?);
    }
    let pids: Vec<String> = children.iter().map(|child| child.id().to_string()).collect();
    println!("ready {}", pids.join(" "));
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
