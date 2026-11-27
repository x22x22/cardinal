# Cardinal Agent Notes

## Toolchain And Boundaries
- Rust is pinned by `rust-toolchain.toml` to `nightly-2025-12-11`; `search-cache/src/lib.rs` uses `#![feature(str_from_raw_parts)]`, so stable builds will fail.
- The root Cargo workspace excludes the desktop app (`Cargo.toml` has `exclude = ["cardinal"]`). Root `cargo check/test/clippy/fmt` only cover the shared crates and CLIs, not `cardinal/src-tauri`.
- The desktop app is split across `cardinal/` (React/Vite frontend) and `cardinal/src-tauri/` (Tauri shell). The Tauri crate pulls shared crates by relative path, so changes in shared Rust code can require both root-workspace and Tauri verification.

## Verified Commands
- Shared Rust workspace CI order: `cargo fmt --all -- --check` -> `cargo clippy --workspace --all-targets -- -D warnings` -> `cargo check --workspace --all-targets` -> `cargo test --workspace`.
- Tauri Rust CI order from `cardinal/src-tauri`: `cargo fmt -- --check` -> `cargo clippy --all-targets -- -D warnings` -> `cargo check --all-targets` -> `cargo test`.
- Frontend CI order from `cardinal/`: `npm ci` -> `npm run format:check` -> `npm run typecheck` -> `npm test -- --run` -> `npm run build`.
- Full desktop dev loop from `cardinal/`: `npm run tauri dev -- --release --features dev`.
- Production desktop bundle from `cardinal/`: `npm run tauri build`.

## Architecture Pointers
- Frontend entrypoint is `cardinal/src/main.tsx`; it boots i18n, app menu, global shortcuts, and the Tauri event runtime before rendering `App`.
- Main UI orchestration lives in `cardinal/src/App.tsx`; most behavior is pushed into hooks under `cardinal/src/hooks/`.
- Tauri entrypoint is `cardinal/src-tauri/src/lib.rs`; commands are in `commands.rs`, and the filesystem scan / cache / event pipeline runs in `background.rs`.
- `search-cache/` is the core indexing and query engine; many search semantics and Rust integration tests live under `search-cache/src/tests/`.
- `lsf/` is an interactive CLI over the same cache engine; `was/` is a separate CLI that streams filesystem events via `cardinal-sdk`.

## Repo-Specific Gotchas
- Do not rely on `TESTING.md`; it is referenced by old instructions but does not exist in this checkout.
- `cardinal/vite.config.ts` hardcodes dev server port `1420` with `strictPort: true`; if that port is busy, `tauri dev` fails instead of picking another port.
- Vite ignores `cardinal/src-tauri/**` for file watching, so Rust-side edits require the Tauri process to rebuild; frontend hot reload will not see them.
- `cardinal/src-tauri/tauri.conf.json` builds macOS bundles with `signingIdentity: "-"`; local `npm run tauri build` produces runnable `.app`/`.dmg` artifacts but skips notarization unless Apple credentials are provided.
- The current checked-in `rust-toolchain.toml` (`nightly-2025-12-11`) is newer than `.github/workflows/rust-ci.yml` (`nightly-2025-05-09`). Trust the repo toolchain file for local work unless CI is being updated as part of the task.
