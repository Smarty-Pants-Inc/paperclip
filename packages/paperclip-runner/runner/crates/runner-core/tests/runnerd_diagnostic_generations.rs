// Keep reason: data safety; a failed replacement must not erase the prior crash.
use std::fs;
use std::process::Command;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[test]
fn consecutive_runnerd_generations_keep_both_diagnostics() {
    let directory = std::env::temp_dir().join(format!(
        "runnerd-diagnostic-generations-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&directory).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();

    for args in [vec![], vec!["--run-id", "second-generation"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_paperclip-runnerd"))
            .args(args)
            .arg("--diagnostics-directory")
            .arg(&directory)
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
    let mut contents = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            #[cfg(unix)]
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::read_to_string(path).unwrap()
        })
        .collect::<Vec<_>>();
    contents.sort();
    // Assert before cleanup only after saving the observations, so RED leaves no junk.
    let latest = fs::read_to_string(directory.join("runnerd.stderr.log")).unwrap();
    fs::remove_dir_all(directory).unwrap();
    assert_eq!(
        contents.len(),
        2,
        "both failed generations need separate logs: {contents:?}"
    );
    assert!(contents
        .iter()
        .any(|value| value.contains("missing required argument --run-id")));
    assert!(latest.contains("missing required argument --session-id"));
}
