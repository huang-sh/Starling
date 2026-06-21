//! Built-in model capability settings.
//!
//! Keep model-specific constants here so monitor/session metric code can stay
//! focused on reducing transcript data rather than carrying per-model tables.

pub const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub aliases: &'static [&'static str],
    pub context_window: u64,
}

pub const MODEL_SPECS: &[ModelSpec] = &[
    ModelSpec {
        id: "glm-5.2",
        aliases: &["glm-5.2"],
        context_window: 1_000_000,
    },
    ModelSpec {
        id: "glm-5.1",
        aliases: &["glm-5.1"],
        context_window: 200_000,
    },
    ModelSpec {
        id: "glm-5",
        aliases: &["glm-5"],
        context_window: 200_000,
    },
    ModelSpec {
        id: "gpt-5.5",
        aliases: &["gpt-5.5"],
        context_window: 1_000_000,
    },
    ModelSpec {
        id: "gpt-5.4-mini",
        aliases: &["gpt-5.4-mini"],
        context_window: 400_000,
    },
    ModelSpec {
        id: "gpt-5.4",
        aliases: &["gpt-5.4"],
        context_window: 1_000_000,
    },
];

pub fn configured_context_window_for_model(model: Option<&str>) -> Option<u64> {
    let normalized = match model {
        Some(s) if !s.trim().is_empty() => s.trim().to_lowercase(),
        _ => return None,
    };

    if normalized.contains("1m") || normalized.contains("1000k") {
        return Some(1_000_000);
    }

    MODEL_SPECS
        .iter()
        .find(|spec| {
            normalized.contains(spec.id)
                || spec.aliases.iter().any(|alias| normalized.contains(alias))
        })
        .map(|spec| spec.context_window)
}

pub fn context_window_for_model(model: Option<&str>) -> u64 {
    configured_context_window_for_model(model).unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_window_recognizes_glm_52_as_one_million() {
        assert_eq!(context_window_for_model(Some("glm-5.2")), 1_000_000);
        assert_eq!(context_window_for_model(Some("GLM-5.2")), 1_000_000);
        assert_eq!(context_window_for_model(Some("glm-5.2 with high effort")), 1_000_000);
    }

    #[test]
    fn context_window_recognizes_gpt_55_as_one_million() {
        assert_eq!(context_window_for_model(Some("gpt-5.5")), 1_000_000);
        assert_eq!(context_window_for_model(Some("GPT-5.5")), 1_000_000);
        assert_eq!(configured_context_window_for_model(Some("gpt-5.5")), Some(1_000_000));
    }

    #[test]
    fn context_window_recognizes_gpt_54_variants() {
        assert_eq!(context_window_for_model(Some("gpt-5.4")), 1_000_000);
        assert_eq!(context_window_for_model(Some("GPT-5.4")), 1_000_000);
        assert_eq!(context_window_for_model(Some("gpt-5.4-mini")), 400_000);
        assert_eq!(context_window_for_model(Some("gpt-5.4-mini with high effort")), 400_000);
    }

    #[test]
    fn context_window_recognizes_glm_51_and_glm_5_as_two_hundred_k() {
        assert_eq!(context_window_for_model(Some("glm-5.1")), 200_000);
        assert_eq!(context_window_for_model(Some("GLM-5.1")), 200_000);
        assert_eq!(configured_context_window_for_model(Some("glm-5.1")), Some(200_000));
        assert_eq!(context_window_for_model(Some("glm-5")), 200_000);
        assert_eq!(configured_context_window_for_model(Some("glm-5")), Some(200_000));
    }

    #[test]
    fn context_window_keeps_default_for_unknown_models() {
        assert_eq!(context_window_for_model(Some("unknown-model")), DEFAULT_CONTEXT_WINDOW);
        assert_eq!(configured_context_window_for_model(Some("unknown-model")), None);
        assert_eq!(context_window_for_model(None), DEFAULT_CONTEXT_WINDOW);
        assert_eq!(context_window_for_model(Some("")), DEFAULT_CONTEXT_WINDOW);
    }
}
