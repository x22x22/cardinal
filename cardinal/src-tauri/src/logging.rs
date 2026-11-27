//! 生产可用的日志落盘。
//!
//! 背景：此前 `tracing` 只写 stdout/stderr，而 macOS 上双击 `.app` 启动时两者都被丢弃，
//! 导致线上问题（CPU 飙高、搜索卡死）完全无法排查。
//!
//! 设计约束：
//! - 日志写入**不得阻塞**后台事件循环：调用方只做一次无界通道 `send`（微秒级），
//!   真正的磁盘 IO 在独立的 writer 线程里合并批量完成。
//! - 队列积压时**丢弃并计数**，绝不反压业务线程。
//! - 按大小滚动（默认 8MB × 5 份），文件 0600、目录 0700。
//! - panic 走同步直写，保证崩溃现场最后一帧不丢。
//! - 级别优先级：`CARDINAL_LOG` > `RUST_LOG` > `info`。

use crossbeam_channel::{Receiver, Sender, TrySendError, unbounded};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// 日志目录（相对用户 HOME）。
const LOG_DIR: &str = "Library/Logs/com.cardinal.one";
const LOG_FILE: &str = "cardinal.log";
/// 单个日志文件的大小上限。
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 滚动保留的历史文件数量。
const MAX_ROTATED_FILES: usize = 5;
/// writer 线程的最长攒批时间；同时决定日志可见延迟上限。
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// 攒批缓存上限，超过即落盘，避免内存无界增长。
const MAX_PENDING_BYTES: usize = 64 * 1024;
/// writer 线程单轮最多处理的消息数，避免一次性吃掉整个队列。
const MAX_BATCH_ITEMS: usize = 4096;

/// 日志落盘端点，可被多个 writer 实例克隆共享。
struct LogSink {
    tx: Sender<Vec<u8>>,
    dropped: AtomicU64,
}

impl LogSink {
    fn emit(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        match self.tx.try_send(bytes.to_vec()) {
            Ok(()) => {}
            // 队列积压时丢弃并计数：宁可丢日志也不阻塞业务线程。
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// 单次事件写入用的 `io::Write` 适配器。
///
/// `tracing_subscriber` 会在一次事件格式化过程中复用同一个 writer，
/// 因此这里按行缓冲，遇到换行就提交整行。
struct LogWriter {
    sink: Arc<LogSink>,
    buf: Vec<u8>,
}

impl LogWriter {
    fn new(sink: Arc<LogSink>) -> Self {
        Self {
            sink,
            buf: Vec::with_capacity(256),
        }
    }
}

impl Write for LogWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        // 一次事件可能分多次 write，只有拿到完整行才提交。
        while let Some(pos) = self.buf.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            self.sink.emit(&line);
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            self.sink.emit(&line);
        }
        Ok(())
    }
}

/// 日志文件路径；无法确定 HOME 时返回 `None`。
fn log_file_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(Path::new(&home).join(LOG_DIR).join(LOG_FILE))
}

/// 把 `cardinal.log` 滚动为 `cardinal.log.1` 等，最多保留 [`MAX_ROTATED_FILES`] 份。
fn rotate(path: &Path) {
    for index in (1..MAX_ROTATED_FILES).rev() {
        let from = path.with_extension(format!("log.{index}"));
        let to = path.with_extension(format!("log.{}", index + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
    let _ = fs::rename(path, path.with_extension("log.1"));
}

fn open_log_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

/// writer 线程：合并批量写入，按大小滚动。
fn writer_loop(rx: Receiver<Vec<u8>>, path: PathBuf, dropped: Arc<AtomicU64>) {
    let mut file = match open_log_file(&path) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("[cardinal] 无法打开日志文件 {}: {error}", path.display());
            return;
        }
    };
    let mut written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut pending: Vec<u8> = Vec::with_capacity(MAX_PENDING_BYTES);
    let mut batch_items = 0usize;

    loop {
        let message = rx.recv_timeout(FLUSH_INTERVAL);
        match message {
            Ok(bytes) => {
                pending.extend_from_slice(&bytes);
                batch_items += 1;
                // 队列里还有积压就继续吃，直到达到单轮上限。
                while batch_items < MAX_BATCH_ITEMS {
                    match rx.try_recv() {
                        Ok(bytes) => {
                            pending.extend_from_slice(&bytes);
                            batch_items += 1;
                        }
                        Err(_) => break,
                    }
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                // 发送端已全部释放：写完最后的缓冲再退出。
                let _ = file.write_all(&pending);
                let _ = file.flush();
                return;
            }
        }

        if pending.is_empty() {
            continue;
        }
        if written + pending.len() as u64 > MAX_FILE_BYTES {
            let _ = file.flush();
            drop(file);
            rotate(&path);
            file = match open_log_file(&path) {
                Ok(file) => file,
                Err(error) => {
                    eprintln!("[cardinal] 日志滚动后重新打开失败: {error}");
                    return;
                }
            };
            written = 0;
        }
        if file.write_all(&pending).is_err() || file.flush().is_err() {
            // 写盘失败时不要无限重试，丢弃积压继续跑业务。
            dropped.fetch_add(batch_items as u64, Ordering::Relaxed);
        } else {
            written += pending.len() as u64;
        }
        pending.clear();
        batch_items = 0;
    }
}

fn env_filter(default: &str) -> EnvFilter {
    for key in ["CARDINAL_LOG", "RUST_LOG"] {
        if let Ok(value) = std::env::var(key)
            && let Ok(filter) = EnvFilter::try_new(&value)
        {
            return filter;
        }
    }
    EnvFilter::new(default)
}

/// 崩溃现场：同步直写文件，绕过队列，确保最后一帧落盘。
fn install_panic_hook(path: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(mut file) = open_log_file(&path) {
            let _ = writeln!(file, "PANIC: {info}");
            let _ = file.flush();
        }
        previous(info);
    }));
}

/// 初始化全局日志：文件 + 级别过滤。返回日志文件路径（用于界面展示/排障提示）。
pub fn init() -> Option<PathBuf> {
    let path = log_file_path()?;
    if let Some(dir) = path.parent() {
        if fs::create_dir_all(dir).is_err() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }

    let (tx, rx) = unbounded::<Vec<u8>>();
    let sink = Arc::new(LogSink {
        tx,
        dropped: AtomicU64::new(0),
    });
    let dropped = Arc::new(AtomicU64::new(0));
    let dropped_for_writer = dropped.clone();
    let writer_path = path.clone();
    // writer 线程是唯一做磁盘 IO 的地方；起不来就只能退回 stderr。
    if std::thread::Builder::new()
        .name("cardinal-log-writer".to_string())
        .spawn(move || writer_loop(rx, writer_path, dropped_for_writer))
        .is_err()
    {
        return None;
    }

    install_panic_hook(path.clone());

    let sink_for_layer = sink.clone();
    tracing_subscriber::registry()
        .with(env_filter("info"))
        .with(
            fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_thread_names(true)
                .with_writer(move || LogWriter::new(sink_for_layer.clone())),
        )
        .init();

    // 记录一次启动基线，便于把后续时间线与进程生命周期对齐。
    tracing::info!(
        target: "cardinal::logging",
        log_file = %path.display(),
        version = env!("CARGO_PKG_VERSION"),
        "日志系统已初始化"
    );

    Some(path)
}
