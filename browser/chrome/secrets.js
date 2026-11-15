// Third-party API keys the Mac keeps for the user (OMDb). The extension only hands a key over:
// it is never stored in chrome.storage, never read back and never sent anywhere but the local
// intake. Pure module: runs in node tests too.
import { postJson } from "./capture.js";

export const SECRETS_FEATURE = "secrets-v1";
export const SECRET_ROUTES = Object.freeze({
  status: "/api/v1/secrets/status",
  set: "/api/v1/secrets/set",
  test: "/api/v1/secrets/test"
});
export const OMDB_KEY = "omdb_api_key";
// OMDb keys are short hex-like tokens; this only rejects obvious paste mistakes.
export const OMDB_KEY_PATTERN = /^[A-Za-z0-9]{6,64}$/;

// { set: boolean } or throws an intake error.
export async function secretStatus(endpoint, secret, name = OMDB_KEY, fetchImpl = fetch) {
  const body = await postJson(endpoint, secret, SECRET_ROUTES.status, { name }, fetchImpl, { timeoutMs: 10000 });
  return { set: body.set === true };
}

// An empty value clears the key on the Mac.
export async function setSecret(endpoint, secret, value, name = OMDB_KEY, fetchImpl = fetch) {
  const body = await postJson(endpoint, secret, SECRET_ROUTES.set, { name, value }, fetchImpl, { timeoutMs: 10000 });
  return { set: body.set === true };
}

const TEST_CODES = ["not_set", "rejected", "network", "no_rating"];

// The Mac looks up one known film with its stored key: { ok, code, rottenTomatoes }.
export async function testSecret(endpoint, secret, name = OMDB_KEY, fetchImpl = fetch) {
  const body = await postJson(endpoint, secret, SECRET_ROUTES.test, { name }, fetchImpl, { timeoutMs: 20000 });
  const rating = typeof body.rotten_tomatoes === "string" && /^\d{1,3}$/.test(body.rotten_tomatoes) ? body.rotten_tomatoes : null;
  return { ok: body.ok === true, code: TEST_CODES.includes(body.code) ? body.code : null, rottenTomatoes: rating };
}
