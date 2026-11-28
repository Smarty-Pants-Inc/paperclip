//! Atomic replacement when a restoring filesystem temporarily rejects rename.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static EXDEV_RETRY_COUNT: AtomicU64 = AtomicU64::new(0);

/// Number of EXDEV-triggered rename retries attempted by this process.
pub fn exdev_retry_count() -> u64 {
    EXDEV_RETRY_COUNT.load(Ordering::Relaxed)
}

const EXDEV_RETRY_BUDGET: Duration = Duration::from_secs(20);
const INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_secs(2);

/// Rename an already-written temporary file over its same-directory target.
///
/// On Unix EXDEV only, retain the bytes and permissions, unlink the temporary
/// file, then recreate and fsync it after each wait. Reusing the pathname keeps
/// caller cleanup unchanged; `create_new` ensures a fresh file, not the inode
/// created while the directory was restoring. Publication is always rename,
/// never a copy into the target. Callers still own any parent-directory fsync.
pub fn rename_replace_retrying_exdev(temporary: &Path, target: &Path) -> io::Result<()> {
    rename_replace_retrying_exdev_within(temporary, target, EXDEV_RETRY_BUDGET)
}

/// Like [`rename_replace_retrying_exdev`], with a caller-supplied retry budget.
/// The budget bounds EXDEV retry waits, not filesystem operation durations.
pub fn rename_replace_retrying_exdev_within(
    temporary: &Path,
    target: &Path,
    budget: Duration,
) -> io::Result<()> {
    let started = Instant::now();
    rename_replace_retrying_exdev_with(
        temporary,
        target,
        budget,
        |source, destination| fs::rename(source, destination),
        std::thread::sleep,
        || started.elapsed(),
    )
}

fn is_exdev(error: &io::Error) -> bool {
    // Windows error 18 is not EXDEV.
    cfg!(unix) && error.raw_os_error() == Some(18)
}

fn rename_replace_retrying_exdev_with(
    temporary: &Path,
    target: &Path,
    budget: Duration,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
    mut sleep: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
) -> io::Result<()> {
    let original_error = match rename(temporary, target) {
        Err(error) if is_exdev(&error) => error,
        result => return result,
    };
    let saved = (|| -> io::Result<_> {
        Ok((fs::read(temporary)?, fs::metadata(temporary)?.permissions()))
    })();
    fs::remove_file(temporary)?;
    let (bytes, permissions) = saved?;
    let target_name = target.file_name().unwrap_or_default().to_string_lossy();
    let mut retries = 0_u64;
    let mut backoff = INITIAL_BACKOFF;
    loop {
        let elapsed_before_wait = elapsed();
        let remaining = budget.saturating_sub(elapsed_before_wait);
        if remaining.is_zero() {
            eprintln!(
                "paperclip-runnerd: rename EXDEV retries exhausted attempts={} elapsed_ms={} target={target_name}",
                retries + 1,
                elapsed_before_wait.as_millis(),
            );
            return Err(original_error);
        }
        sleep(backoff.min(remaining));
        backoff = (backoff * 2).min(MAX_BACKOFF);
        let elapsed_after_wait = elapsed();
        if elapsed_after_wait >= budget {
            eprintln!(
                "paperclip-runnerd: rename EXDEV retries exhausted attempts={} elapsed_ms={} target={target_name}",
                retries + 1,
                elapsed_after_wait.as_millis(),
            );
            return Err(original_error);
        }

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(permissions.mode());
        }
        // Do not clean up a pathname we failed to create (e.g. a collision).
        let mut file = options.open(temporary)?;
        let result = (|| {
            file.set_permissions(permissions.clone())?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            // Match runnerd's existing warning facility: stderr, without a
            // subscriber or filter that could hide an individual retry.
            retries += 1;
            EXDEV_RETRY_COUNT.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "paperclip-runnerd: rename EXDEV retry attempt={retries} elapsed_ms={} target={target_name}",
                elapsed().as_millis(),
            );
            rename(temporary, target)
        })();
        match result {
            Ok(()) => {
                eprintln!(
                    "paperclip-runnerd: rename succeeded after exdev_retries={retries} elapsed_ms={} target={target_name}",
                    elapsed().as_millis(),
                );
                return Ok(());
            }
            Err(error) => {
                let cleanup = fs::remove_file(temporary);
                if !is_exdev(&error) {
                    return Err(error);
                }
                cleanup?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // Keep process-wide counter deltas independent of parallel EXDEV tests.
    static EXDEV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct Fixture {
        directory: std::path::PathBuf,
        temporary: std::path::PathBuf,
        target: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "runner-atomic-replace-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&directory).unwrap();
            let temporary = directory.join("state.tmp");
            let target = directory.join("state.json");
            fs::write(&temporary, b"replacement bytes").unwrap();
            fs::write(&target, b"old bytes").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).unwrap();
            }
            Self {
                directory,
                temporary,
                target,
            }
        }

        fn assert_no_temporary(&self) {
            assert!(!self.temporary.exists());
            assert_eq!(fs::read_dir(&self.directory).unwrap().count(), 1);
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    // Injected EXDEV and a fake clock exercise real temporary files and rename
    // without needing a filesystem that is still being restored.
    #[cfg(unix)]
    #[test]
    fn exdev_twice_then_succeeds_with_original_bytes_and_no_temporary() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = EXDEV_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let elapsed = Cell::new(Duration::ZERO);
        let mut attempts = 0;
        let mut waits = Vec::new();
        rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            EXDEV_RETRY_BUDGET,
            |temporary, target| {
                attempts += 1;
                assert_eq!(fs::read(temporary).unwrap(), b"replacement bytes");
                assert_eq!(fs::read(target).unwrap(), b"old bytes");
                assert_eq!(
                    fs::metadata(temporary).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                if attempts <= 2 {
                    Err(io::Error::from_raw_os_error(18))
                } else {
                    fs::rename(temporary, target)
                }
            },
            |wait| {
                assert!(!fixture.temporary.exists());
                waits.push(wait);
                elapsed.set(elapsed.get() + wait);
            },
            || elapsed.get(),
        )
        .unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(
            waits,
            [Duration::from_millis(100), Duration::from_millis(200)]
        );
        assert_eq!(fs::read(&fixture.target).unwrap(), b"replacement bytes");
        fixture.assert_no_temporary();
    }

    #[cfg(unix)]
    #[test]
    fn persistent_exdev_returns_original_error_at_budget_with_no_temporary() {
        let _guard = EXDEV_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let elapsed = Cell::new(Duration::ZERO);
        let original = io::Error::from_raw_os_error(18);
        let expected = (
            original.raw_os_error(),
            original.kind(),
            original.to_string(),
        );
        let mut first = Some(original);
        let mut attempts = 0;
        let mut last_wait = Duration::ZERO;
        let error = rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            EXDEV_RETRY_BUDGET,
            |temporary, _| {
                attempts += 1;
                assert_eq!(fs::read(temporary).unwrap(), b"replacement bytes");
                Err(first
                    .take()
                    .unwrap_or_else(|| io::Error::from_raw_os_error(18)))
            },
            |wait| {
                assert!(!fixture.temporary.exists());
                assert!(wait <= MAX_BACKOFF);
                last_wait = wait;
                elapsed.set(elapsed.get() + wait);
            },
            || elapsed.get(),
        )
        .unwrap_err();
        assert_eq!(
            (error.raw_os_error(), error.kind(), error.to_string()),
            expected
        );
        assert_eq!(elapsed.get(), EXDEV_RETRY_BUDGET);
        assert_eq!(attempts, 14);
        assert_eq!(last_wait, Duration::from_millis(900));
        assert_eq!(fs::read(&fixture.target).unwrap(), b"old bytes");
        fixture.assert_no_temporary();
    }

    // Unit test agreed: an injected persistent EXDEV and fake clock prove the
    // journal's shorter budget without a real filesystem restore or sleep.
    #[cfg(unix)]
    #[test]
    fn persistent_exdev_with_one_second_budget_returns_original_error_within_one_second() {
        let _guard = EXDEV_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let budget = Duration::from_secs(1);
        let elapsed = Cell::new(Duration::ZERO);
        let original = io::Error::from_raw_os_error(18);
        let expected = (
            original.raw_os_error(),
            original.kind(),
            original.to_string(),
        );
        let mut first = Some(original);
        let mut waits = Vec::new();
        let error = rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            budget,
            |_, _| {
                Err(first
                    .take()
                    .unwrap_or_else(|| io::Error::from_raw_os_error(18)))
            },
            |wait| {
                waits.push(wait);
                elapsed.set(elapsed.get() + wait);
                assert!(elapsed.get() <= budget);
            },
            || elapsed.get(),
        )
        .unwrap_err();
        assert_eq!(
            (error.raw_os_error(), error.kind(), error.to_string()),
            expected
        );
        assert_eq!(elapsed.get(), budget);
        assert_eq!(waits, [100, 200, 400, 300].map(Duration::from_millis));
        assert_eq!(fs::read(&fixture.target).unwrap(), b"old bytes");
        fixture.assert_no_temporary();
    }

    // Unit test agreed: injected EXDEV and a fake clock measure the exact
    // process-wide retry delta without a live filesystem restore.
    #[cfg(unix)]
    #[test]
    fn counter_rises_by_the_number_of_exdev_retries() {
        let _guard = EXDEV_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let before = exdev_retry_count();
        let elapsed = Cell::new(Duration::ZERO);
        let mut attempts = 0;
        rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            EXDEV_RETRY_BUDGET,
            |temporary, target| {
                attempts += 1;
                if attempts <= 2 {
                    Err(io::Error::from_raw_os_error(18))
                } else {
                    fs::rename(temporary, target)
                }
            },
            |wait| elapsed.set(elapsed.get() + wait),
            || elapsed.get(),
        )
        .unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(exdev_retry_count() - before, 2);
        fixture.assert_no_temporary();
    }

    #[test]
    fn non_exdev_is_not_retried_or_changed() {
        let fixture = Fixture::new();
        let error = rename_replace_retrying_exdev_with(
            &fixture.temporary,
            &fixture.target,
            EXDEV_RETRY_BUDGET,
            |_, _| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "original denial",
                ))
            },
            |_| panic!("non-EXDEV must not wait"),
            || panic!("non-EXDEV must not consult the retry clock"),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), "original denial");
        // The fast path preserves the caller's existing cleanup ownership.
        assert_eq!(fs::read(&fixture.temporary).unwrap(), b"replacement bytes");
        assert_eq!(fs::read(&fixture.target).unwrap(), b"old bytes");
    }
}
