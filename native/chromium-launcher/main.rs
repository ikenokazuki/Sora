//! Chromium を、root のまま起動せず、別の uid・gid に落としてから exec する小さな起動用バイナリ。
//!
//! Sora 本体（root）が、puppeteer の executablePath にこれを指定する。puppeteer は、これに Chromium の引数を渡して起動する。
//! exec で置き換わる（pid・開いている fd は変わらない）ので、puppeteer のパイプ接続（fd 3・4）・`browser.process()`・終了の処理は、そのまま使える。
//! 設定は、環境変数で受け取る（puppeteer の引数に混ぜられないため）。Chromium には渡さない:
//!   SORA_LAUNCH_EXEC  起動する本物の Chromium の絶対パス
//!   SORA_LAUNCH_UID   落とし先の uid（0 は不可）
//!   SORA_LAUNCH_GID   落とし先の gid（省略時は UID と同じ）
//!
//! 落とせなかったとき（権限がない・不正な値）は、root のまま起動せず、終了コード 126 で止まる。
//! 設計: docs/superpowers/specs/2026-11-12-isolation-design.md（設計 2）

use std::os::unix::process::CommandExt;
use std::process::{exit, Command};

extern "C" {
    // glibc の prctl は、可変長引数（int prctl(int option, ...)）
    fn prctl(option: i32, ...) -> i32;
}

/// setuid バイナリなどで、権限を増やさせない（Chromium 自身のサンドボックスも、これを前提にしている）
const PR_SET_NO_NEW_PRIVS: i32 = 38;

fn fail(message: &str) -> ! {
    eprintln!("sora-chromium-launch: {message}");
    exit(126)
}

fn id(name: &str, fallback: Option<u32>) -> u32 {
    match std::env::var(name) {
        Ok(value) => value.trim().parse().unwrap_or_else(|_| fail(&format!("{name} が数ではない: {value:?}"))),
        Err(_) => fallback.unwrap_or_else(|| fail(&format!("{name} がない"))),
    }
}

fn main() {
    let exec = std::env::var("SORA_LAUNCH_EXEC").unwrap_or_else(|_| fail("SORA_LAUNCH_EXEC がない"));
    if !exec.starts_with('/') {
        fail("SORA_LAUNCH_EXEC は絶対パスにする");
    }
    let uid = id("SORA_LAUNCH_UID", None);
    let gid = id("SORA_LAUNCH_GID", Some(uid));
    if uid == 0 || gid == 0 {
        fail("uid・gid 0 には落とせない");
    }

    // SAFETY: 引数は定数（unsigned long）。失敗は戻り値で見る
    if unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1u64, 0u64, 0u64, 0u64) } != 0 {
        fail("PR_SET_NO_NEW_PRIVS に失敗した");
    }

    // uid・gid の変更（root なら、補助グループも空にする）は、exec の前に std が行う。失敗すれば exec は戻る
    let error = Command::new(&exec)
        .args(std::env::args_os().skip(1))
        .env_remove("SORA_LAUNCH_EXEC")
        .env_remove("SORA_LAUNCH_UID")
        .env_remove("SORA_LAUNCH_GID")
        .uid(uid)
        .gid(gid)
        .exec();
    fail(&format!("{exec} を起動できない（uid {uid}・gid {gid} に落とせなかった可能性）: {error}"));
}
