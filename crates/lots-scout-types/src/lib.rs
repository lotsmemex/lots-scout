//! Capture input and extractor draft output: everything an extractor needs,
//! and nothing about how a library stores items, revisions or evidence.

use serde::{Deserialize, Serialize};

/// Schema version of the capture records defined here.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Public,
    Internal,
    Private,
    Restricted,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DraftAttachmentRef {
    Remote {
        url: String,
        media_type: Option<String>,
        title: Option<String>,
    },
    Captured {
        blob_index: u32,
        blob_id: String,
        title: Option<String>,
    },
}

pub fn captured_attachment_relative_path(blob_id: &str, media_type: &str) -> Option<String> {
    let digest = blob_id.strip_prefix("sha256:")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let extension = match media_type {
        "image/gif" => "gif",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        _ => return None,
    };
    Some(format!("attachments/sha256-{digest}.{extension}"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceProfile {
    pub schema_version: u32,
    pub source_id: String,
    pub name: String,
    pub source_kind: String,
    #[serde(default)]
    pub canonical_uris: Vec<String>,
    #[serde(default)]
    pub evidence_roles: Vec<String>,
    pub default_sensitivity: Sensitivity,
    pub preferred_extractor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobDescriptor {
    pub schema_version: u32,
    pub locator: String,
    pub media_type: String,
    pub byte_size: u64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureEnvelope {
    pub schema_version: u32,
    pub adapter_id: String,
    pub adapter_version: String,
    pub external_capture_id: String,
    pub source_id: String,
    pub captured_at: String,
    pub capture_method: String,
    pub sensitivity: Sensitivity,
    pub route_summary: Option<String>,
    pub title: Option<String>,
    pub source_url: String,
    pub canonical_url: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<BlobDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedBlob {
    pub descriptor: BlobDescriptor,
    pub blob_id: String,
    pub source_backend_ref: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCapture {
    pub source: SourceProfile,
    pub capture: CaptureEnvelope,
    pub blobs: Vec<VerifiedBlob>,
}

/// The rating metrics an item can carry. Serialized names are the stored
/// metric names, so they must not change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RatingMetric {
    DoubanBook,
    Goodreads,
    Imdb,
    DoubanMovie,
    RottenTomatoes,
    CitationCount,
}

/// One rating of an item from one source. `value` and `scale` are decimal
/// strings so comparisons stay exact; counts such as citations leave `scale`
/// empty. `fetched_at` is an RFC 3339 UTC timestamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rating {
    pub source: String,
    pub metric: RatingMetric,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    pub fetched_at: String,
}

/// Where an item title came from. Serialized names are stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    User,
    Douban,
    ImdbAkas,
    Wikidata,
    Ai,
}

/// What kind of title it is: the original, an official (release) title,
/// an alternative such as a working title or alias, or an AI translation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleKind {
    Original,
    Official,
    Alternative,
    Ai,
}

/// One title of an item in one language. `lang` is a normalized BCP 47 tag
/// of language or language-region (see [`normalize_title_lang`]);
/// `fetched_at` is RFC 3339 UTC and set for external sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemTitle {
    pub title: String,
    pub lang: String,
    pub source: TitleSource,
    pub kind: TitleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

/// Normalizes a language tag to "language" or "language-REGION": a 2–3
/// letter language in lower case and an optional 2-letter or 3-digit region
/// in upper case. `_` is accepted as separator. Anything else, including
/// script subtags such as `zh-Hans`, gives `None`.
pub fn normalize_title_lang(tag: &str) -> Option<String> {
    let mut parts = tag.trim().split(['-', '_']);
    let lang = parts.next()?;
    let region = parts.next();
    if parts.next().is_some()
        || !(2..=3).contains(&lang.len())
        || !lang.chars().all(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    let lang = lang.to_ascii_lowercase();
    match region {
        None => Some(lang),
        Some(r)
            if (r.len() == 2 && r.chars().all(|c| c.is_ascii_alphabetic()))
                || (r.len() == 3 && r.chars().all(|c| c.is_ascii_digit())) =>
        {
            Some(format!("{lang}-{}", r.to_ascii_uppercase()))
        }
        Some(_) => None,
    }
}

/// What an extractor produces from one capture. Bibliographic metadata is
/// not part of it: the library adds that when it turns a draft into an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExtractedDraft {
    pub item_type: String,
    pub title: String,
    pub source_url: String,
    pub canonical_url: Option<String>,
    pub content_markdown: String,
    pub sensitivity: Sensitivity,
    pub extractor_id: String,
    pub extractor_version: String,
    pub attachments: Vec<DraftAttachmentRef>,
    /// Ratings shown on the captured page itself, such as a Douban score.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ratings: Vec<Rating>,
}
