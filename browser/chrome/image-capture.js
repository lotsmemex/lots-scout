// Injected after an explicit capture click. Only public, credential-free raster
// URLs in this already-rendered article are requested; no video bytes or scripts.
export async function collectImageEvidence(urls) {
  const images = [], missing = [];
  let total = 0;
  for (const source_url of [...new Set(urls)].slice(0, 32)) {
    try {
      const url = new URL(source_url);
      if (url.protocol !== "https:" || url.username || url.password ||
          /^(?:localhost\.?$|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[)/i.test(url.hostname) ||
          /\.(?:local|localhost)\.?$/i.test(url.hostname)) throw new Error();
      const response = await fetch(url.href, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        cache: "no-store", signal: AbortSignal.timeout(5000) });
      const media_type = response.headers.get("content-type")?.split(";")[0].trim();
      if (!response.ok || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(media_type)) throw new Error();
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024 || total + size > 20 * 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let binary = "";
      for (let i = 0; i < size; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      images.push({ source_url, media_type, body_base64: btoa(binary) });
      total += size;
    } catch { missing.push(source_url); }
  }
  return { images, missing: missing.length + Math.max(0, new Set(urls).size - 32) };
}
