//! Display helpers — mirrors src/lib/sessionDisplay.ts.

pub const SHORT_SESSION_ID_LENGTH: usize = 13;

pub fn short_session_id(session_id: &str) -> &str {
    let len = session_id.chars().count();
    if len <= SHORT_SESSION_ID_LENGTH {
        session_id
    } else {
        let end = session_id
            .char_indices()
            .nth(SHORT_SESSION_ID_LENGTH)
            .map(|(i, _)| i)
            .unwrap_or(session_id.len());
        &session_id[..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_id() {
        assert_eq!(
            short_session_id("abcdef0123456789abcdef0123456789"),
            "abcdef0123456"
        );
    }

    #[test]
    fn keeps_short_id() {
        assert_eq!(short_session_id("short"), "short");
    }
}
