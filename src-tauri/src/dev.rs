//! Development identity is tied to the compiled worktree, never the launch cwd.

pub fn configure(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    context.config_mut().identifier = identifier(env!("OPENIDEA_WORKTREE_ROOT"));
    context
}

fn identifier(root: &str) -> String {
    // FNV-1a, shared with scripts/dev-session.ts.
    let hash =
        root.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    format!("ai.l0ng.openidea.dev.w{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_matches_launcher_and_separates_worktrees() {
        assert_eq!(identifier("/repo/idea"), "ai.l0ng.openidea.dev.w158e9c5954b7bf64");
        assert_ne!(identifier("/repo/idea"), identifier("/repo/idea-other"));
    }
}
