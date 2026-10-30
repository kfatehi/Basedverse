//! visit (../../V2.md): the program. Everything it does is the `visit` library (lib.rs), which a workroom's own
//! server can link instead, to run visit, its sign-in and its engine in one program of its own.
use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    // A blank setting (`VISIT_PORT=` in a .env, ../../.env.example) means its default, as .env files have it;
    // clap would take it as an empty value. Done before the runtime starts any thread.
    for (k, v) in std::env::vars_os() {
        if v.is_empty() && ["VISIT_", "AUTH_", "ENGINE_"].iter().any(|p| k.to_string_lossy().starts_with(p)) {
            std::env::remove_var(&k);
        }
    }
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("the tokio runtime");
    match std::env::args().nth(1).as_deref() {
        Some("auth") => return rt.block_on(visit::auth_command()),
        Some("psql" | "status" | "import") => return rt.block_on(visit::command(visit::Command::parse())),
        _ => {}
    }
    rt.block_on(visit::run(visit::Args::parse(), visit::asked_to_stop()))
}
