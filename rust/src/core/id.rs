//! ID generators — mirrors src/lib/id.ts.

use crate::types::{Bookmark, Space};

/// `starling_NNNN` — strictly increasing across existing bookmark IDs.
pub fn generate_bookmark_id(bookmarks: &[Bookmark]) -> String {
    let max = bookmarks
        .iter()
        .filter_map(|b| b.id.strip_prefix("starling_"))
        .filter_map(|rest| rest.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    format!("starling_{:04}", max + 1)
}

/// `cat_NNNN` — strictly increasing, tolerating legacy `space_NNNN` prefixes.
pub fn generate_space_id(spaces: &[Space]) -> String {
    let max = spaces
        .iter()
        .map(|s| {
            let rest =
                s.id.strip_prefix("cat_")
                    .or_else(|| s.id.strip_prefix("space_"))
                    .unwrap_or(&s.id);
            rest.parse::<u32>().ok()
        })
        .flatten()
        .max()
        .unwrap_or(0);
    format!("cat_{:04}", max + 1)
}

/// `note_<ms>_<6-char-base36>` — note that this is best-effort unique. We use
/// nanoseconds + a 6-byte random suffix for entropy.
pub fn generate_note_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let suffix: String = (0..6)
        .map(|_| {
            let n = uuid::Uuid::new_v4().as_u128() % 36;
            char::from_digit(n as u32, 36).unwrap_or('0')
        })
        .collect();
    format!("note_{ms}_{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_bookmark(id: &str) -> Bookmark {
        Bookmark {
            id: id.into(),
            provider: "claude".into(),
            session_id: "s".into(),
            title: "t".into(),
            category: "c".into(),
            tags: vec![],
            project_path: "/p".into(),
            first_prompt: "".into(),
            notes: vec![],
            space_ids: vec![],
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[derive(Default)]
    struct SpaceBuilder;
    impl SpaceBuilder {
        fn mk(id: &str) -> Space {
            Space {
                id: id.into(),
                name: "n".into(),
                description: String::new(),
                tags: vec![],
                parent_id: None,
                created_at: "t".into(),
                updated_at: "t".into(),
            }
        }
    }

    #[test]
    fn bookmark_id_increments() {
        let bs = vec![mk_bookmark("starling_0003"), mk_bookmark("starling_0010")];
        assert_eq!(generate_bookmark_id(&bs), "starling_0011");
    }

    #[test]
    fn bookmark_id_from_empty() {
        assert_eq!(generate_bookmark_id(&[]), "starling_0001");
    }

    #[test]
    fn space_id_tolerates_legacy_prefix() {
        let spaces = vec![SpaceBuilder::mk("cat_0007"), SpaceBuilder::mk("space_0042")];
        assert_eq!(generate_space_id(&spaces), "cat_0043");
    }

    #[test]
    fn space_id_from_empty() {
        assert_eq!(generate_space_id(&[]), "cat_0001");
    }

    #[test]
    fn note_id_shape() {
        let id = generate_note_id();
        assert!(id.starts_with("note_"), "got: {id}");
        // note_<digits>_<6 alnum>
        let parts: Vec<&str> = id.split('_').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2].len(), 6);
    }
}
