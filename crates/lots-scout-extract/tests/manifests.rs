//! sources/*/manifest.yaml is documentation, not read at runtime. This
//! test keeps it in step with the code: one manifest per extractor, with the
//! same id, base version and output version variants.
use lots_scout_extract::{
    AmpPodcastExtractor, GenericWebpageExtractor, LinkresearcherArticleExtractor, Extractor,
    WeixinArticleExtractor,
};
use std::{collections::BTreeMap, fs, path::Path};

fn field<'a>(yaml: &'a str, key: &str) -> &'a str {
    let prefix = format!("{key}:");
    let line = yaml
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with(&prefix))
        .unwrap_or_else(|| panic!("missing {key}"));
    line[prefix.len()..].trim()
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches('\'').to_string()
}

#[test]
fn every_extractor_has_a_matching_manifest() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sources");
    let mut manifests = BTreeMap::new();
    for entry in fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path().join("manifest.yaml");
        if let Ok(yaml) = fs::read_to_string(&path) {
            manifests.insert(field(&yaml, "id").to_string(), yaml);
        }
    }
    let sources: [&dyn Extractor; 4] = [
        &GenericWebpageExtractor,
        &WeixinArticleExtractor,
        &LinkresearcherArticleExtractor,
        &AmpPodcastExtractor,
    ];
    let mut source = String::new();
    for entry in fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("src")).unwrap() {
        source += &fs::read_to_string(entry.unwrap().path()).unwrap();
    }
    for extractor in sources {
        let yaml = manifests
            .remove(extractor.id())
            .unwrap_or_else(|| panic!("no manifest.yaml for {}", extractor.id()));
        assert_eq!(field(&yaml, "extractor_used"), extractor.id());
        assert_eq!(unquote(field(&yaml, "extractor_version")), extractor.version());
        let major = field(&yaml, "version").split('.').next().unwrap().to_string();
        assert_eq!(major, extractor.version(), "{} manifest version", extractor.id());
        let variants: Vec<String> = field(&yaml, "output_variants")
            .trim_matches(|c| c == '[' || c == ']')
            .split(',')
            .map(unquote)
            .collect();
        assert!(variants.contains(&extractor.version().to_string()));
        for variant in &variants {
            assert!(source.contains(&format!("\"{variant}\"")), "{variant} not produced by code");
        }
    }
    assert!(manifests.is_empty(), "manifests without a extractor: {:?}", manifests.keys());
}
