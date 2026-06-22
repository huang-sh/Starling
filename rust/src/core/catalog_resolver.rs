//! Catalog (a.k.a. Space) resolution — mirrors src/lib/catalogResolver.ts.

use crate::core::store::{find_space_candidates, list_spaces};
use crate::types::Space;

#[derive(Debug)]
pub enum CatalogResolution {
    Found(Space),
    NotFound,
    Ambiguous(Vec<Space>),
}

/// Resolve a string reference (ID, name, or slash-path) to a single catalog.
pub fn resolve_catalog_reference(r#ref: &str) -> CatalogResolution {
    let matches = find_space_candidates(r#ref);
    match matches.len() {
        0 => CatalogResolution::NotFound,
        1 => CatalogResolution::Found(matches.into_iter().next().unwrap()),
        _ => CatalogResolution::Ambiguous(matches),
    }
}

/// Render the slash-separated path for a catalog by walking up the parent
/// chain. Cycles are guarded against.
pub fn catalog_path(space: &Space, spaces: Option<&[Space]>) -> String {
    let owned: Vec<Space>;
    let spaces: &[Space] = match spaces {
        Some(s) => s,
        None => {
            owned = list_spaces();
            &owned
        }
    };

    let mut parts = vec![space.name.clone()];
    let mut current_id = space.parent_id.clone();
    let mut seen = std::collections::HashSet::new();

    while let Some(pid) = current_id {
        if !seen.insert(pid.clone()) {
            break;
        }
        let parent = match spaces.iter().find(|s| s.id == pid) {
            Some(p) => p,
            None => break,
        };
        parts.insert(0, parent.name.clone());
        current_id = parent.parent_id.clone();
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs_utils::test_support::with_temp_store;
    use crate::core::store::{add_space, load_store};
    use crate::types::Space;

    fn mk_space(id: &str, name: &str, parent_id: Option<&str>) -> Space {
        Space {
            id: id.into(),
            name: name.into(),
            description: "".into(),
            tags: vec![],
            parent_id: parent_id.map(String::from),
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn resolve_by_exact_id() {
        with_temp_store(|| {
            let r = resolve_catalog_reference("cat_0001");
            match r {
                CatalogResolution::Found(s) => assert_eq!(s.name, "claude"),
                other => panic!("expected Found, got {:?}", other),
            }
        });
    }

    #[test]
    fn resolve_ambiguous_name() {
        with_temp_store(|| {
            add_space(mk_space("cat_0101", "dupe", None));
            add_space(mk_space("cat_0102", "dupe", None));
            match resolve_catalog_reference("dupe") {
                CatalogResolution::Ambiguous(v) => assert_eq!(v.len(), 2),
                other => panic!("expected Ambiguous, got {:?}", other),
            }
        });
    }

    #[test]
    fn resolve_missing() {
        with_temp_store(|| match resolve_catalog_reference("does-not-exist") {
            CatalogResolution::NotFound => {}
            other => panic!("expected NotFound, got {:?}", other),
        });
    }

    #[test]
    fn catalog_path_walks_parents() {
        with_temp_store(|| {
            add_space(mk_space("cat_0101", "root", None));
            add_space(mk_space("cat_0102", "mid", Some("cat_0101")));
            add_space(mk_space("cat_0103", "leaf", Some("cat_0102")));
            let spaces: Vec<Space> = load_store().spaces;
            let leaf = spaces.iter().find(|s| s.id == "cat_0103").unwrap();
            let path = catalog_path(leaf, Some(&spaces));
            assert_eq!(path, "root/mid/leaf");
        });
    }
}
