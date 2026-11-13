export const INTAKE_PATH = "/api/v1/captures";
export const SECRET_PATTERN = /^[0-9a-f]{64}$/;
export const NO_CAPABILITIES = Object.freeze({ urlJobs: false, comments: false, qualityCheck: false, features: Object.freeze([]) });
export const SETTING_KEYS = ["endpoint", "intakeSecret", "defaultQualityCheck", "defaultComments"];

export function validateEndpoint(value) {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" &&
      Number.isInteger(port) && port >= 1024 && port <= 65535 &&
      url.pathname === INTAKE_PATH && !url.username && !url.password &&
      !url.search && !url.hash && url.href === value;
  } catch { return false; }
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomHex32() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// `options.comments` / `options.qualityCheck` are set only when the intake advertised
// comments-v1 / quality-check-v1; otherwise the manifest stays plain snapshot V1.
export async function buildCapture(snapshot, now = new Date(), options = {}) {
  const bytes = new TextEncoder().encode(snapshot.html);
  if (!snapshot.sourceUrl || bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error("invalid_snapshot");
  }
  const metadata = {};
  if (snapshot.metadata.creators) {
    const names = Array.isArray(snapshot.metadata.creators) ? snapshot.metadata.creators : [snapshot.metadata.creators];
    metadata.creators = names.slice(0, 32).map((display_name) => ({ display_name, role: "author" }));
  }
  if (snapshot.metadata.publishedDate) metadata.published_date = snapshot.metadata.publishedDate;
  if (snapshot.metadata.language) metadata.language = snapshot.metadata.language;
  if (snapshot.metadata.siteName) metadata.site_name = snapshot.metadata.siteName;
  if (snapshot.metadata.abstract) metadata.abstract = snapshot.metadata.abstract;
  const manifest = {
    schema_version: 1,
    external_capture_id: options.requestId || `chrome-${randomHex32()}`,
    captured_at: now.toISOString(),
    source_url: snapshot.sourceUrl,
    canonical_url: snapshot.canonicalUrl || null,
    title: snapshot.title || null,
    sensitivity: "internal",
    metadata,
    // Embedded videos travel as remote references (Mac never fetches them during intake).
    attachments: (snapshot.videos || []).map((url) => ({ url, media_type: "text/html", title: "Video" })),
    images: [],
    html: { media_type: "text/html", byte_size: bytes.byteLength, sha256: await sha256Hex(bytes) }
  };
  const imageParts = [];
  if (options.webSnapshot) {
    manifest.web = { target_group_id: options.targetGroupId || null };
    let total = 0;
    for (const image of (options.images || []).slice(0, 32)) {
      const bytes = Uint8Array.from(atob(image.body_base64), (c) => c.charCodeAt(0));
      total += bytes.byteLength;
      if (bytes.byteLength > 2 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error("invalid_snapshot");
      manifest.images.push({ source_url: image.source_url, media_type: image.media_type,
        byte_size: bytes.byteLength, sha256: await sha256Hex(bytes) });
      imageParts.push(bytes);
    }
  }
  let commentBytes = null;
  if (options.comments && snapshot.comments) {
    if (snapshot.comments.state === "captured") {
      commentBytes = new TextEncoder().encode(snapshot.comments.html);
      manifest.comments = { state: "captured", html: { media_type: "text/html", byte_size: commentBytes.byteLength, sha256: await sha256Hex(commentBytes) } };
    } else {
      manifest.comments = { state: snapshot.comments.state, html: null };
    }
  }
  if (options.qualityCheck) manifest.quality_check = options.qualityCheck;
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const prefix = new Uint8Array(12);
  prefix.set([0x4d, 0x45, 0x4d, 0x45, 0x58, 0x00, 0x00, 0x01]); // "MEMEX\0\0\x01"
  new DataView(prefix.buffer).setUint32(8, manifestBytes.byteLength, false);
  // Binary framing is HTML, images in manifest order, then optional comments.
  const parts = [prefix, manifestBytes, bytes, ...imageParts, ...(commentBytes ? [commentBytes] : [])];
  return { manifest, body: new Blob(parts, { type: "application/vnd.memex.capture-v1" }) };
}

export async function postCapture(endpoint, secret, body) {
  if (!validateEndpoint(endpoint) || !SECRET_PATTERN.test(secret)) throw new Error("invalid_settings");
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.memex.capture-v1",
      "X-MemeX-Intake-Secret": secret,
      "X-MemeX-Intake-Nonce": randomHex32()
    },
    body,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(30_000)
  });
}

// `http_status` is the response status when there was one; `timeout` marks a request that got no answer in
// time (still code "unknown"). Errors never carry the URL, headers, secret, nonce or body.
const intakeError = (code, extra = {}) => Object.assign(new Error(code), { code, http_status: null, timeout: false, ...extra });

// Authenticated JSON POST to another route of the same loopback intake. A route the server does
// not have (bare 404 from an old server) is `unavailable`; a dropped connection or any 5xx (e.g. the Mac
// still warming up) is `unknown`, whatever the body says. `timeoutMs` bounds the whole exchange; a request
// that gets no answer in time is `unknown` too (it may still have reached the Mac).
export async function postJson(endpoint, secret, route, payload, fetchImpl = fetch, { timeoutMs = 0 } = {}) {
  if (!validateEndpoint(endpoint) || !SECRET_PATTERN.test(secret)) throw intakeError("unavailable");
  let response;
  try {
    response = await fetchImpl(new URL(route, endpoint).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MemeX-Intake-Secret": secret, "X-MemeX-Intake-Nonce": randomHex32() },
      body: JSON.stringify({ schema_version: 1, ...payload }),
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
  } catch (error) { throw intakeError("unknown", { timeout: error?.name === "TimeoutError" }); }
  let body = null;
  try { body = await response.json(); } catch (error) { if (error?.name === "TimeoutError") throw intakeError("unknown", { timeout: true }); }
  const http_status = response.status;
  if (!response.ok) {
    if (http_status >= 500) throw intakeError("unknown", { http_status });
    if (typeof body?.error === "string") throw intakeError(body.error, { http_status });
    throw intakeError(http_status === 404 ? "unavailable" : "unknown", { http_status });
  }
  if (!body || body.schema_version !== 1) throw intakeError("unknown", { http_status });
  return body;
}

export async function discoverCapabilities(endpoint, secret, fetchImpl = fetch) {
  try {
    const { features } = await postJson(endpoint, secret, "/api/v1/capabilities", {}, fetchImpl);
    const has = (name) => Array.isArray(features) && features.includes(name);
    return { urlJobs: has("url-jobs-v1"), comments: has("comments-v1"), qualityCheck: has("quality-check-v1"), webSnapshot: has("web-snapshot-v1"),
      features: Array.isArray(features) ? features.filter((name) => typeof name === "string").slice(0, 64) : [] };
  } catch { return NO_CAPABILITIES; }
}
