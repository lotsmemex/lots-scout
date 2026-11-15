//! Ratings from external sources, without any networking.
//!
//! This module builds request URLs and parses responses; the caller sends
//! the requests and supplies `fetched_at` (RFC 3339 UTC). A library CLI uses
//! it like this:
//!
//! 1. Citations: for an item with a DOI, GET [`openalex_work_url`] and pass
//!    the body to [`parse_openalex_citations`]. When OpenAlex has no record
//!    (404) or the parse gives `None`, GET [`crossref_work_url`] and use
//!    [`parse_crossref_citations`].
//! 2. IMDb: download `title.ratings.tsv.gz` from the official IMDb datasets
//!    (personal, non-commercial use only), decompress it, and pass the
//!    stream with the wanted ids to [`imdb_ratings_lookup`]. Ids come from
//!    [`imdb_title_id`].
//! 3. Rotten Tomatoes: with the user's own OMDb key (never bundled), GET
//!    [`omdb_title_url`] and use [`parse_omdb_rotten_tomatoes`]. OMDb data is
//!    CC BY-NC 4.0 and must be credited to OMDb. The URL contains the key, so
//!    do not log it.
//!
//! Each `Some(Rating)` is then written to the item by the library.

use anyhow::{bail, Context, Result};
use lots_scout_types::{Rating, RatingMetric};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::BufRead;
use url::Url;

/// Lower-cased bare DOI ("10.x/y") from a DOI, `doi:` form or doi.org URL.
pub fn normalize_doi(input: &str) -> Option<String> {
    let s = input.trim();
    let lower = s.to_ascii_lowercase();
    let mut rest = lower.as_str();
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ] {
        if let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped.trim_start();
            break;
        }
    }
    let (registrant, suffix) = rest.split_once('/')?;
    let digits = registrant.strip_prefix("10.")?;
    if digits.is_empty()
        || !digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        || suffix.is_empty()
        || suffix.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    Some(rest.to_string())
}

/// Percent-encodes a DOI for a URL path, keeping `/` so the API sees the
/// DOI's own structure.
fn encode_doi_path(doi: &str) -> String {
    let mut out = String::with_capacity(doi.len());
    for b in doi.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn doi_or_bail(doi: &str) -> Result<String> {
    normalize_doi(doi).with_context(|| "ratings_invalid_doi".to_string())
}

/// OpenAlex single-work lookup by DOI. `mailto` is optional contact info.
pub fn openalex_work_url(doi: &str, mailto: Option<&str>) -> Result<Url> {
    let doi = doi_or_bail(doi)?;
    let mut url = Url::parse(&format!(
        "https://api.openalex.org/works/doi:{}",
        encode_doi_path(&doi)
    ))?;
    url.query_pairs_mut()
        .append_pair("select", "cited_by_count");
    if let Some(mailto) = mailto {
        url.query_pairs_mut().append_pair("mailto", mailto);
    }
    Ok(url)
}

/// Crossref work lookup by DOI. Crossref asks clients to send `mailto`.
pub fn crossref_work_url(doi: &str, mailto: Option<&str>) -> Result<Url> {
    let doi = doi_or_bail(doi)?;
    let mut url = Url::parse(&format!(
        "https://api.crossref.org/works/{}",
        encode_doi_path(&doi)
    ))?;
    if let Some(mailto) = mailto {
        url.query_pairs_mut().append_pair("mailto", mailto);
    }
    Ok(url)
}

fn citation_rating(source: &str, count: Option<&Value>, fetched_at: &str) -> Option<Rating> {
    let n = count?.as_u64()?;
    Some(Rating {
        source: source.to_string(),
        metric: RatingMetric::CitationCount,
        value: n.to_string(),
        scale: None,
        count: None,
        fetched_at: fetched_at.to_string(),
    })
}

/// `cited_by_count` of an OpenAlex work response.
pub fn parse_openalex_citations(body: &str, fetched_at: &str) -> Result<Option<Rating>> {
    let json: Value = serde_json::from_str(body).context("ratings_openalex_invalid_json")?;
    Ok(citation_rating(
        "openalex",
        json.get("cited_by_count"),
        fetched_at,
    ))
}

/// `message.is-referenced-by-count` of a Crossref work response.
pub fn parse_crossref_citations(body: &str, fetched_at: &str) -> Result<Option<Rating>> {
    let json: Value = serde_json::from_str(body).context("ratings_crossref_invalid_json")?;
    Ok(citation_rating(
        "crossref",
        json.get("message")
            .and_then(|m| m.get("is-referenced-by-count")),
        fetched_at,
    ))
}

/// IMDb title id ("tt0111161") from a bare id or an imdb.com title URL.
pub fn imdb_title_id(input: &str) -> Option<String> {
    let s = input.trim();
    let candidate = if let Ok(url) = Url::parse(s) {
        let host = url.host_str()?.to_ascii_lowercase();
        if host != "imdb.com" && !host.ends_with(".imdb.com") {
            return None;
        }
        let mut segments = url.path_segments()?;
        if segments.next()? != "title" {
            return None;
        }
        segments.next()?.to_string()
    } else {
        s.to_string()
    };
    let digits = candidate.strip_prefix("tt")?;
    (digits.len() >= 7 && digits.chars().all(|c| c.is_ascii_digit())).then_some(candidate)
}

fn is_decimal(s: &str) -> bool {
    let (int, frac) = s.split_once('.').unwrap_or((s, "0"));
    !int.is_empty()
        && !frac.is_empty()
        && int.chars().all(|c| c.is_ascii_digit())
        && frac.chars().all(|c| c.is_ascii_digit())
}

/// Reads the decompressed IMDb `title.ratings.tsv` stream and returns a
/// rating for each wanted id found in it. Malformed data rows fail the
/// whole lookup rather than produce a wrong rating.
pub fn imdb_ratings_lookup<R: BufRead>(
    reader: R,
    wanted: &BTreeSet<String>,
    fetched_at: &str,
) -> Result<BTreeMap<String, Rating>> {
    let mut lines = reader.lines();
    let header = lines.next().transpose()?.unwrap_or_default();
    if header.trim_end() != "tconst\taverageRating\tnumVotes" {
        bail!("ratings_imdb_unexpected_header");
    }
    let mut found = BTreeMap::new();
    for line in lines {
        if found.len() == wanted.len() {
            break;
        }
        let line = line?;
        let mut fields = line.trim_end_matches('\r').split('\t');
        let (Some(id), Some(avg), Some(votes), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            bail!("ratings_imdb_malformed_row");
        };
        if !wanted.contains(id) {
            continue;
        }
        let votes: u64 = votes.parse().context("ratings_imdb_malformed_row")?;
        if !is_decimal(avg) {
            bail!("ratings_imdb_malformed_row");
        }
        found.insert(
            id.to_string(),
            Rating {
                source: "imdb".to_string(),
                metric: RatingMetric::Imdb,
                value: avg.to_string(),
                scale: Some("10".to_string()),
                count: Some(votes),
                fetched_at: fetched_at.to_string(),
            },
        );
    }
    Ok(found)
}

/// OMDb lookup by IMDb id with the user's own API key.
pub fn omdb_title_url(imdb_id: &str, api_key: &str) -> Result<Url> {
    let id = imdb_title_id(imdb_id).context("ratings_invalid_imdb_id")?;
    if api_key.trim().is_empty() {
        bail!("ratings_omdb_missing_key");
    }
    let mut url = Url::parse("https://www.omdbapi.com/")?;
    url.query_pairs_mut()
        .append_pair("i", &id)
        .append_pair("apikey", api_key.trim());
    Ok(url)
}

/// The Rotten Tomatoes critics score ("94%") in an OMDb response, if any.
/// OMDb error responses (`"Response": "False"`) are errors, not `None`.
pub fn parse_omdb_rotten_tomatoes(body: &str, fetched_at: &str) -> Result<Option<Rating>> {
    let json: Value = serde_json::from_str(body).context("ratings_omdb_invalid_json")?;
    if json.get("Response").and_then(Value::as_str) == Some("False") {
        bail!("ratings_omdb_error");
    }
    let Some(ratings) = json.get("Ratings").and_then(Value::as_array) else {
        return Ok(None);
    };
    for entry in ratings {
        if entry.get("Source").and_then(Value::as_str) != Some("Rotten Tomatoes") {
            continue;
        }
        let Some(percent) = entry
            .get("Value")
            .and_then(Value::as_str)
            .and_then(|v| v.trim().strip_suffix('%'))
        else {
            return Ok(None);
        };
        if !is_decimal(percent) {
            return Ok(None);
        }
        return Ok(Some(Rating {
            source: "omdb".to_string(),
            metric: RatingMetric::RottenTomatoes,
            value: percent.to_string(),
            scale: Some("100".to_string()),
            count: None,
            fetched_at: fetched_at.to_string(),
        }));
    }
    Ok(None)
}

/// The rated page a URL is, if any: rating source, metric, default scale
/// and the item type of what the page describes.
fn rated_page(source_url: &str) -> Option<(&'static str, RatingMetric, &'static str, &'static str)> {
    let url = Url::parse(source_url).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();
    Some(match host.as_str() {
        "book.douban.com" if path.starts_with("/subject/") => {
            ("douban", RatingMetric::DoubanBook, "10", "book")
        }
        "movie.douban.com" if path.starts_with("/subject/") => {
            ("douban", RatingMetric::DoubanMovie, "10", "film")
        }
        "www.goodreads.com" | "goodreads.com" if path.starts_with("/book/show/") => {
            ("goodreads", RatingMetric::Goodreads, "5", "book")
        }
        "www.imdb.com" | "imdb.com" | "m.imdb.com" => {
            // Only the title's main page, not its reviews, cast or other subpages.
            let mut segments = path.trim_end_matches('/').split('/').skip(1);
            match (segments.next(), segments.next().and_then(imdb_title_id), segments.next()) {
                (Some("title"), Some(_), None) => ("imdb", RatingMetric::Imdb, "10", "film"),
                _ => return None,
            }
        }
        _ => return None,
    })
}

/// The item type of a page that describes a book or a film, such as a
/// Douban subject, a Goodreads book or an IMDb title page.
pub fn page_item_type(source_url: &str) -> Option<&'static str> {
    rated_page(source_url).map(|(_, _, _, item_type)| item_type)
}

/// Ratings shown on a captured Douban, Goodreads or IMDb title page, read from the page
/// itself: the rating, its scale and the number of raters. Other sites, and
/// pages without a rating, give none. `fetched_at` is the capture time.
pub fn page_ratings(source_url: &str, html: &str, fetched_at: &str) -> Vec<Rating> {
    let Some((source, metric, default_scale, _)) = rated_page(source_url) else {
        return Vec::new();
    };
    let document = dom_query::Document::from(html);
    let found = if source == "douban" {
        douban_rdfa_rating(&document).or_else(|| json_ld_rating(&document))
    } else {
        json_ld_rating(&document)
    };
    let Some((value, scale, count)) = found else {
        return Vec::new();
    };
    let scale = scale.unwrap_or_else(|| default_scale.to_string());
    if !is_decimal(&value) || !is_decimal(&scale) || count == Some(0) {
        return Vec::new();
    }
    match (value.parse::<f64>(), scale.parse::<f64>()) {
        (Ok(v), Ok(s)) if s > 0.0 && v <= s => {}
        _ => return Vec::new(),
    }
    vec![Rating {
        source: source.to_string(),
        metric,
        value,
        scale: Some(scale),
        count,
        fetched_at: fetched_at.to_string(),
    }]
}

type PageRating = (String, Option<String>, Option<u64>);

/// Douban marks its rating with RDFa: `v:average`, `v:best` and `v:votes`.
fn douban_rdfa_rating(document: &dom_query::Document) -> Option<PageRating> {
    let text = |selector: &str| {
        let t = document.select(selector).first().text();
        let t = t.trim().to_string();
        (!t.is_empty()).then_some(t)
    };
    let value = text("[property='v:average']")?;
    let scale = document
        .select("[property='v:best']")
        .first()
        .attr("content")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let count = text("[property='v:votes']").and_then(|c| c.parse().ok());
    Some((value, scale, count))
}

fn json_scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The first schema.org `aggregateRating` in the page's JSON-LD.
fn json_ld_rating(document: &dom_query::Document) -> Option<PageRating> {
    let mut found = None;
    crate::walk_json_ld(document, |node| {
        let rating = &node["aggregateRating"];
        if let Some(value) = json_scalar(&rating["ratingValue"]) {
            let scale = json_scalar(&rating["bestRating"]);
            let count = json_scalar(&rating["ratingCount"]).and_then(|c| c.parse().ok());
            found = Some((value, scale, count));
        }
        found.is_some()
    });
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-11-14T08:00:00Z";

    #[test]
    fn doi_forms_normalize_and_encode_without_losing_slashes() {
        assert_eq!(
            normalize_doi(" https://doi.org/10.1000/ABC(1)/x ").as_deref(),
            Some("10.1000/abc(1)/x")
        );
        assert_eq!(normalize_doi("doi:10.5555/x").as_deref(), Some("10.5555/x"));
        assert_eq!(normalize_doi("11.1000/x"), None);
        assert_eq!(normalize_doi("10.1000/"), None);
        assert_eq!(normalize_doi("10.1000/a b"), None);
        let url = openalex_work_url("10.1000/abc(1)/x?y", Some("a@example.org")).unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.openalex.org/works/doi:10.1000/abc%281%29/x%3Fy?select=cited_by_count&mailto=a%40example.org"
        );
        assert_eq!(
            crossref_work_url("10.1000/x", None).unwrap().as_str(),
            "https://api.crossref.org/works/10.1000/x"
        );
        assert!(openalex_work_url("not a doi", None).is_err());
    }

    #[test]
    fn citation_counts_parse_from_both_sources() {
        let r = parse_openalex_citations(r#"{"cited_by_count":0}"#, AT)
            .unwrap()
            .unwrap();
        assert_eq!((r.source.as_str(), r.value.as_str()), ("openalex", "0"));
        assert_eq!((r.scale, r.count), (None, None));
        assert_eq!(parse_openalex_citations("{}", AT).unwrap(), None);
        let c = parse_crossref_citations(
            r#"{"message":{"is-referenced-by-count":1234,"cited-by-count":9}}"#,
            AT,
        )
        .unwrap()
        .unwrap();
        assert_eq!((c.source.as_str(), c.value.as_str()), ("crossref", "1234"));
        assert_eq!(
            parse_crossref_citations(r#"{"message":{}}"#, AT).unwrap(),
            None
        );
        assert!(parse_crossref_citations("<html>", AT).is_err());
    }

    #[test]
    fn imdb_ids_come_only_from_imdb_title_urls() {
        assert_eq!(
            imdb_title_id("https://m.imdb.com/title/tt0111161/?ref_=x").as_deref(),
            Some("tt0111161")
        );
        assert_eq!(imdb_title_id("tt12345678").as_deref(), Some("tt12345678"));
        assert_eq!(imdb_title_id("https://example.com/title/tt0111161/"), None);
        assert_eq!(imdb_title_id("https://www.imdb.com/name/nm0000001/"), None);
        assert_eq!(imdb_title_id("tt123"), None);
    }

    #[test]
    fn imdb_lookup_matches_exact_ids_and_rejects_bad_data() {
        let tsv = "tconst\taverageRating\tnumVotes\n\
                   tt0000001\t5.7\t2100\n\
                   tt00000010\t9.9\t1\n\
                   tt0000010\t10\t42\n";
        let wanted: BTreeSet<String> = ["tt0000001", "tt0000010", "tt9999999"]
            .into_iter()
            .map(String::from)
            .collect();
        let found = imdb_ratings_lookup(tsv.as_bytes(), &wanted, AT).unwrap();
        assert_eq!(found.len(), 2);
        let a = &found["tt0000001"];
        assert_eq!((a.value.as_str(), a.count), ("5.7", Some(2100)));
        assert_eq!(a.scale.as_deref(), Some("10"));
        assert_eq!(found["tt0000010"].value, "10");

        let bad_header = "id\trating\n";
        assert!(imdb_ratings_lookup(bad_header.as_bytes(), &wanted, AT).is_err());
        let bad_row = "tconst\taverageRating\tnumVotes\ntt0000001\t\\N\t3\n";
        assert!(imdb_ratings_lookup(bad_row.as_bytes(), &wanted, AT).is_err());
    }

    #[test]
    fn omdb_url_requires_key_and_rotten_tomatoes_parses_percent() {
        assert!(omdb_title_url("tt0111161", " ").is_err());
        assert_eq!(
            omdb_title_url("tt0111161", "k&y").unwrap().as_str(),
            "https://www.omdbapi.com/?i=tt0111161&apikey=k%26y"
        );
        let body = r#"{"Response":"True","Ratings":[
            {"Source":"Internet Movie Database","Value":"9.3/10"},
            {"Source":"Rotten Tomatoes","Value":"89%"}]}"#;
        let r = parse_omdb_rotten_tomatoes(body, AT).unwrap().unwrap();
        assert_eq!((r.source.as_str(), r.value.as_str()), ("omdb", "89"));
        assert_eq!(r.scale.as_deref(), Some("100"));
        assert_eq!(r.metric, RatingMetric::RottenTomatoes);
        assert_eq!(
            parse_omdb_rotten_tomatoes(
                r#"{"Response":"True","Ratings":[{"Source":"Rotten Tomatoes","Value":"N/A"}]}"#,
                AT
            )
            .unwrap(),
            None
        );
        assert!(parse_omdb_rotten_tomatoes(
            r#"{"Response":"False","Error":"Invalid API key!"}"#,
            AT
        )
        .is_err());
    }

    #[test]
    fn rating_serializes_to_the_agreed_shape() {
        let r = parse_openalex_citations(r#"{"cited_by_count":7}"#, AT)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"source":"openalex","metric":"citation_count","value":"7","fetched_at":"2026-11-14T08:00:00Z"}"#
        );
        let back: Rating = serde_json::from_str(
            r#"{"source":"douban","metric":"douban_book","value":"8.7","scale":"10","count":12345,"fetched_at":"2026-11-14T08:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(back.metric, RatingMetric::DoubanBook);
        assert!(serde_json::from_str::<Rating>(
            r#"{"source":"x","metric":"stars","value":"1","fetched_at":"t"}"#
        )
        .is_err());
    }

    #[test]
    fn douban_pages_give_their_own_rating_and_other_sites_none() {
        let book = r#"<html><body><div id="interest_sectl">
            <strong class="ll rating_num" property="v:average"> 8.7 </strong>
            <span property="v:best" content="10.0"></span>
            <a><span property="v:votes">12345</span>人评价</a></div></body></html>"#;
        let r = page_ratings("https://book.douban.com/subject/1084336/", book, AT);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].metric, RatingMetric::DoubanBook);
        assert_eq!((r[0].source.as_str(), r[0].value.as_str()), ("douban", "8.7"));
        assert_eq!((r[0].scale.as_deref(), r[0].count), (Some("10.0"), Some(12345)));
        assert_eq!(r[0].fetched_at, AT);
        let movie = page_ratings("https://movie.douban.com/subject/1292052/", book, AT);
        assert_eq!(movie[0].metric, RatingMetric::DoubanMovie);
        assert!(page_ratings("https://www.douban.com/group/topic/1/", book, AT).is_empty());
        assert!(page_ratings("https://example.com/subject/1/", book, AT).is_empty());

        let unrated = r#"<strong class="ll rating_num" property="v:average"> </strong>
            <span property="v:votes">0</span>"#;
        assert!(page_ratings("https://book.douban.com/subject/1/", unrated, AT).is_empty());
    }

    #[test]
    fn douban_falls_back_to_json_ld_and_goodreads_uses_json_ld() {
        let movie = r#"<script type="application/ld+json">{"@type":"Movie",
            "aggregateRating":{"@type":"AggregateRating","ratingCount":"3000123",
            "bestRating":"10","worstRating":"2","ratingValue":"9.7"}}</script>"#;
        let r = page_ratings("https://movie.douban.com/subject/1292052/", movie, AT);
        assert_eq!((r[0].value.as_str(), r[0].count), ("9.7", Some(3000123)));
        assert_eq!(r[0].scale.as_deref(), Some("10"));

        let goodreads = r#"<script type="application/ld+json">{"@context":"https://schema.org",
            "@type":"Book","name":"X","aggregateRating":{"@type":"AggregateRating",
            "ratingValue":4.33,"ratingCount":98765,"reviewCount":4321}}</script>"#;
        let g = page_ratings("https://www.goodreads.com/book/show/1.X", goodreads, AT);
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].source.as_str(), g[0].metric), ("goodreads", RatingMetric::Goodreads));
        assert_eq!((g[0].value.as_str(), g[0].scale.as_deref()), ("4.33", Some("5")));
        assert_eq!(g[0].count, Some(98765));

        let out_of_scale = goodreads.replace("4.33", "7.5");
        assert!(page_ratings("https://www.goodreads.com/book/show/1", &out_of_scale, AT).is_empty());
        assert!(page_ratings("https://www.goodreads.com/review/list/1", goodreads, AT).is_empty());
    }

    #[test]
    fn imdb_title_pages_give_their_rating_and_film_type() {
        let page = r#"<script type="application/ld+json">{"@context":"https://schema.org",
            "@type":"Movie","url":"https://www.imdb.com/title/tt0111161/","name":"The Shawshank Redemption",
            "aggregateRating":{"@type":"AggregateRating","ratingCount":3012345,"bestRating":10,
            "worstRating":1,"ratingValue":9.3}}</script>"#;
        let r = page_ratings("https://www.imdb.com/title/tt0111161/?ref_=chttp_t_1", page, AT);
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].source.as_str(), r[0].metric), ("imdb", RatingMetric::Imdb));
        assert_eq!((r[0].value.as_str(), r[0].scale.as_deref()), ("9.3", Some("10")));
        assert_eq!(r[0].count, Some(3012345));
        assert_eq!(page_item_type("https://m.imdb.com/title/tt0111161"), Some("film"));
        assert_eq!(page_item_type("https://book.douban.com/subject/1/"), Some("book"));
        assert!(page_ratings("https://www.imdb.com/title/tt0111161/reviews", page, AT).is_empty());
        assert!(page_ratings("https://www.imdb.com/chart/top/", page, AT).is_empty());
        assert_eq!(page_item_type("https://www.imdb.com/title/tt0111161/reviews"), None);
        assert_eq!(page_item_type("https://example.com/"), None);
    }

    #[test]
    fn the_first_aggregate_rating_in_document_order_wins() {
        let page = r#"<script type="application/ld+json">{"@graph":[
            {"@type":"Movie","aggregateRating":{"ratingValue":9.3,"bestRating":10}},
            {"@type":"Movie","aggregateRating":{"ratingValue":4.1,"bestRating":10}}]}</script>"#;
        let r = page_ratings("https://www.imdb.com/title/tt0111161/", page, AT);
        assert_eq!(r[0].value, "9.3");
    }
}
