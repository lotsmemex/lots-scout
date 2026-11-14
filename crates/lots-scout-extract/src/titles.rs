//! Titles of an item in other languages and regions, without networking.
//!
//! 1. IMDb: download `title.akas.tsv.gz` from the official IMDb datasets
//!    (personal, non-commercial use only), decompress it and pass the stream
//!    with the wanted ids to [`imdb_akas_lookup`].
//! 2. Wikidata (CC0): GET [`wikidata_titles_url`] with a descriptive
//!    User-Agent and `Accept: application/sparql-results+json`, then use
//!    [`parse_wikidata_titles`].
//!
//! Each result holds at most one title per (lang, kind), so the library can
//! upsert it by (source, lang, kind).

use crate::ratings::imdb_title_id;
use anyhow::{bail, Context, Result};
use lots_scout_types::{normalize_title_lang, ItemTitle, TitleKind, TitleSource};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::BufRead;
use url::Url;

pub const MAX_TITLES: usize = 64;
pub const MAX_TITLE_BYTES: usize = 4096;

/// The language of a region's titles when IMDb gives only the region.
fn region_language(region: &str) -> Option<&'static str> {
    Some(match region {
        "CN" | "TW" | "HK" | "MO" | "SG" => "zh",
        "JP" => "ja",
        "KR" => "ko",
        "US" | "GB" | "AU" | "NZ" | "IE" => "en",
        "FR" => "fr",
        "DE" | "AT" => "de",
        "ES" | "MX" | "AR" => "es",
        "IT" => "it",
        "BR" | "PT" => "pt",
        "RU" => "ru",
        _ => return None,
    })
}

fn field(value: &str) -> Option<&str> {
    (value != "\\N" && !value.is_empty()).then_some(value)
}

/// BCP 47 tag of an akas row, or `None` when its language is unknown.
fn akas_lang(region: Option<&str>, language: Option<&str>) -> Option<String> {
    let region = region.filter(|r| r.len() == 2 && r.chars().all(|c| c.is_ascii_alphabetic()));
    let language = match language {
        Some("cmn") => Some("zh"),
        // IMDb's private-use codes (qaa–qtz) name no real language.
        Some(l) if l.len() == 3 && l.starts_with('q') => return None,
        Some(l) => Some(l),
        None => region.and_then(region_language),
    }?;
    match region {
        Some(r) => normalize_title_lang(&format!("{language}-{r}")),
        None => normalize_title_lang(language),
    }
}

fn usable(title: &str) -> bool {
    !title.trim().is_empty() && title.len() <= MAX_TITLE_BYTES
}

struct AkasRow {
    ordering: u32,
    title: String,
    lang: String,
    kind: Option<TitleKind>,
}

/// Untyped rows (no types, no attributes) are a region's plain release
/// title: the first one per language becomes official when that language
/// has no `imdbDisplay` title, the rest are alternatives.
fn akas_titles(mut rows: Vec<AkasRow>, fetched_at: &str) -> Vec<ItemTitle> {
    rows.sort_by_key(|row| row.ordering);
    let has_official: BTreeSet<String> = rows
        .iter()
        .filter(|row| row.kind == Some(TitleKind::Official))
        .map(|row| row.lang.clone())
        .collect();
    let mut promoted = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut titles = Vec::new();
    for row in rows {
        let kind = row.kind.unwrap_or_else(|| {
            if !has_official.contains(&row.lang) && promoted.insert(row.lang.clone()) {
                TitleKind::Official
            } else {
                TitleKind::Alternative
            }
        });
        if titles.len() < MAX_TITLES && seen.insert((row.lang.clone(), kind)) {
            titles.push(ItemTitle {
                title: row.title,
                lang: row.lang,
                source: TitleSource::ImdbAkas,
                kind,
                fetched_at: Some(fetched_at.to_string()),
            });
        }
    }
    titles
}

/// Reads the decompressed IMDb `title.akas.tsv` stream and returns titles
/// for each wanted id. Rows of unknown language are skipped; malformed rows
/// of a wanted id fail the lookup.
pub fn imdb_akas_lookup<R: BufRead>(
    reader: R,
    wanted: &BTreeSet<String>,
    fetched_at: &str,
) -> Result<BTreeMap<String, Vec<ItemTitle>>> {
    let mut lines = reader.lines();
    let header = lines.next().transpose()?.unwrap_or_default();
    if header.trim_end()
        != "titleId\tordering\ttitle\tregion\tlanguage\ttypes\tattributes\tisOriginalTitle"
    {
        bail!("titles_imdb_unexpected_header");
    }
    let mut rows: BTreeMap<String, Vec<AkasRow>> = BTreeMap::new();
    for line in lines {
        let line = line?;
        let line = line.trim_end_matches('\r');
        let Some((id, rest)) = line.split_once('\t') else {
            bail!("titles_imdb_malformed_row");
        };
        if !wanted.contains(id) {
            continue;
        }
        let fields: Vec<&str> = rest.split('\t').collect();
        let [ordering, title, region, language, types, attributes, original] = fields[..] else {
            bail!("titles_imdb_malformed_row");
        };
        let ordering: u32 = ordering.parse().context("titles_imdb_malformed_row")?;
        let Some(lang) = akas_lang(field(region), field(language)) else {
            continue;
        };
        if !usable(title) {
            continue;
        }
        let types: Vec<&str> = field(types)
            .map(|t| t.split(['\u{2}', ',']).collect())
            .unwrap_or_default();
        let kind = if original == "1" || types.contains(&"original") {
            Some(TitleKind::Original)
        } else if types.contains(&"imdbDisplay") && field(attributes).is_none() {
            Some(TitleKind::Official)
        } else if !types.is_empty() || field(attributes).is_some() {
            Some(TitleKind::Alternative)
        } else {
            None
        };
        rows.entry(id.to_string()).or_default().push(AkasRow {
            ordering,
            title: title.to_string(),
            lang,
            kind,
        });
    }
    Ok(rows
        .into_iter()
        .map(|(id, rows)| (id, akas_titles(rows, fetched_at)))
        .collect())
}

/// Wikidata SPARQL query for every label of the item with this IMDb id.
pub fn wikidata_titles_url(imdb_id: &str) -> Result<Url> {
    // Validated to `tt` plus digits, so it is safe inside the query string.
    let id = imdb_title_id(imdb_id).context("titles_invalid_imdb_id")?;
    let query = format!(
        "SELECT ?label WHERE {{ ?item wdt:P345 \"{id}\" ; rdfs:label ?label . }} LIMIT 500"
    );
    let mut url = Url::parse("https://query.wikidata.org/sparql")?;
    url.query_pairs_mut()
        .append_pair("query", &query)
        .append_pair("format", "json");
    Ok(url)
}

/// Wikidata label languages as BCP 47 tags. `zh-hans` is generic Chinese;
/// `zh-hant` names no region and is skipped, as are `mul` and `und`.
fn wikidata_lang(code: &str) -> Option<String> {
    match code.to_ascii_lowercase().as_str() {
        "zh-hans" => Some("zh".to_string()),
        "zh-hant" | "mul" | "und" => None,
        other => normalize_title_lang(other),
    }
}

/// Labels from a Wikidata SPARQL JSON response, one per language.
pub fn parse_wikidata_titles(body: &str, fetched_at: &str) -> Result<Vec<ItemTitle>> {
    let json: Value = serde_json::from_str(body).context("titles_wikidata_invalid_json")?;
    let bindings = json["results"]["bindings"]
        .as_array()
        .context("titles_wikidata_unexpected_shape")?;
    let mut seen = BTreeSet::new();
    let mut titles = Vec::new();
    for binding in bindings {
        let label = &binding["label"];
        let (Some(code), Some(title)) = (label["xml:lang"].as_str(), label["value"].as_str()) else {
            continue;
        };
        let Some(lang) = wikidata_lang(code) else {
            continue;
        };
        if titles.len() < MAX_TITLES && usable(title) && seen.insert(lang.clone()) {
            titles.push(ItemTitle {
                title: title.to_string(),
                lang,
                source: TitleSource::Wikidata,
                kind: TitleKind::Official,
                fetched_at: Some(fetched_at.to_string()),
            });
        }
    }
    Ok(titles)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-11-14T08:00:00Z";
    const HEADER: &str =
        "titleId\tordering\ttitle\tregion\tlanguage\ttypes\tattributes\tisOriginalTitle\n";

    fn find<'a>(titles: &'a [ItemTitle], lang: &str, kind: TitleKind) -> Option<&'a str> {
        titles
            .iter()
            .find(|t| t.lang == lang && t.kind == kind)
            .map(|t| t.title.as_str())
    }

    #[test]
    fn lang_tags_normalize_to_language_and_region() {
        assert_eq!(normalize_title_lang("zh_tw").as_deref(), Some("zh-TW"));
        assert_eq!(normalize_title_lang("EN").as_deref(), Some("en"));
        assert_eq!(normalize_title_lang("es-419").as_deref(), Some("es-419"));
        assert_eq!(normalize_title_lang("zh-Hans"), None);
        assert_eq!(normalize_title_lang("zh-Hant-TW"), None);
        assert_eq!(normalize_title_lang("x"), None);
    }

    #[test]
    fn akas_map_regions_kinds_and_keep_one_title_per_lang_and_kind() {
        let tsv = format!(
            "{HEADER}\
             tt0111161\t1\tThe Shawshank Redemption\t\\N\t\\N\toriginal\t\\N\t1\n\
             tt0111161\t2\t刺激1995\tTW\t\\N\t\\N\t\\N\t0\n\
             tt0111161\t3\t肖申克的救赎\tCN\tzh\timdbDisplay\t\\N\t0\n\
             tt0111161\t4\t月黑高飞\tHK\t\\N\t\\N\t\\N\t0\n\
             tt0111161\t5\t地狱诺言\tCN\t\\N\t\\N\t\\N\t0\n\
             tt0111161\t6\tショーシャンクの空に\tJP\tja\timdbDisplay\t\\N\t0\n\
             tt0111161\t7\tRita Hayworth\tUS\t\\N\tworking\t\\N\t0\n\
             tt0111161\t8\tRita Hayworth and Shawshank\tUS\t\\N\tworking\t\\N\t0\n\
             tt0111161\t9\tLes évadés\tXWW\tfr\t\\N\t\\N\t0\n\
             tt0111161\t10\tX\tXYZ\t\\N\t\\N\t\\N\t0\n\
             tt0111161\t11\tY\tUS\tqbn\t\\N\t\\N\t0\n\
             tt0000002\t1\tOther\tUS\t\\N\timdbDisplay\t\\N\t0\n"
        );
        let wanted = BTreeSet::from(["tt0111161".to_string()]);
        let found = imdb_akas_lookup(tsv.as_bytes(), &wanted, AT).unwrap();
        assert_eq!(found.len(), 1);
        let t = &found["tt0111161"];
        // The original row has no region or language, so it is skipped.
        assert!(t.iter().all(|x| x.kind != TitleKind::Original));
        assert_eq!(find(t, "zh-CN", TitleKind::Official), Some("肖申克的救赎"));
        // The untyped CN row is not promoted over imdbDisplay.
        assert_eq!(find(t, "zh-CN", TitleKind::Alternative), Some("地狱诺言"));
        assert_eq!(find(t, "zh-TW", TitleKind::Official), Some("刺激1995"));
        assert_eq!(find(t, "zh-HK", TitleKind::Official), Some("月黑高飞"));
        assert_eq!(find(t, "ja-JP", TitleKind::Official), Some("ショーシャンクの空に"));
        assert_eq!(find(t, "en-US", TitleKind::Alternative), Some("Rita Hayworth"));
        assert_eq!(find(t, "en-US", TitleKind::Official), None);
        assert_eq!(find(t, "fr", TitleKind::Official), Some("Les évadés"));
        assert_eq!(t.len(), 7);
        assert!(t.iter().all(|x| x.source == TitleSource::ImdbAkas
            && x.fetched_at.as_deref() == Some(AT)));

        let original = format!("{HEADER}tt0111161\t1\tO\tUS\ten\t\\N\t\\N\t1\n");
        let o = imdb_akas_lookup(original.as_bytes(), &wanted, AT).unwrap();
        assert_eq!(find(&o["tt0111161"], "en-US", TitleKind::Original), Some("O"));

        let bad = format!("{HEADER}tt0111161\tx\tO\tUS\ten\t\\N\t\\N\t1\n");
        assert!(imdb_akas_lookup(bad.as_bytes(), &wanted, AT).is_err());
        assert!(imdb_akas_lookup("titleId\ttitle\n".as_bytes(), &wanted, AT).is_err());
    }

    #[test]
    fn wikidata_query_is_built_from_a_validated_id_and_labels_map_to_tags() {
        let url = wikidata_titles_url("https://www.imdb.com/title/tt0111161/").unwrap();
        let query = url
            .query_pairs()
            .find(|(k, _)| k == "query")
            .unwrap()
            .1
            .into_owned();
        assert!(query.contains("wdt:P345 \"tt0111161\""));
        assert!(wikidata_titles_url("tt1\" } DELETE {").is_err());

        let body = r#"{"results":{"bindings":[
            {"label":{"xml:lang":"zh-cn","type":"literal","value":"肖申克的救赎"}},
            {"label":{"xml:lang":"zh-hans","type":"literal","value":"肖申克的救赎"}},
            {"label":{"xml:lang":"zh-hant","type":"literal","value":"刺激1995"}},
            {"label":{"xml:lang":"zh-tw","type":"literal","value":"刺激1995"}},
            {"label":{"xml:lang":"ja","type":"literal","value":"ショーシャンクの空に"}},
            {"label":{"xml:lang":"mul","type":"literal","value":"X"}},
            {"label":{"xml:lang":"en","type":"literal","value":"The Shawshank Redemption"}},
            {"label":{"xml:lang":"en","type":"literal","value":"Duplicate"}}]}}"#;
        let t = parse_wikidata_titles(body, AT).unwrap();
        let langs: Vec<&str> = t.iter().map(|x| x.lang.as_str()).collect();
        assert_eq!(langs, ["zh-CN", "zh", "zh-TW", "ja", "en"]);
        assert_eq!(find(&t, "en", TitleKind::Official), Some("The Shawshank Redemption"));
        assert!(t.iter().all(|x| x.source == TitleSource::Wikidata));
        assert!(parse_wikidata_titles(r#"{"error":1}"#, AT).is_err());
    }

    #[test]
    fn item_title_serializes_to_the_agreed_shape() {
        let t = ItemTitle {
            title: "肖申克的救赎".into(),
            lang: "zh-CN".into(),
            source: TitleSource::ImdbAkas,
            kind: TitleKind::Official,
            fetched_at: Some(AT.into()),
        };
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"title":"肖申克的救赎","lang":"zh-CN","source":"imdb_akas","kind":"official","fetched_at":"2026-11-14T08:00:00Z"}"#
        );
        let user: ItemTitle =
            serde_json::from_str(r#"{"title":"T","lang":"en","source":"user","kind":"alternative"}"#)
                .unwrap();
        assert_eq!((user.source, user.fetched_at), (TitleSource::User, None));
    }
}
