// Every wire detail of the destination semantics lives here, checked against
// the backend's chrome_capture_v1 contract, sections "Active UI destination" and
// "Explicit destination modes". Pure module: runs in node tests too.

// Capabilities. Destination semantics (explicit, persisted destination_mode) are enabled only when the
// intake advertises DESTINATION_FEATURE; reading the Mac's current folder has its own gate.
export const DESTINATION_FEATURE = "url-jobs-destination-v1";
export const ACTIVE_GROUP_FEATURE = "url-jobs-active-group-v1";

// Read-only route for the Mac's current (last explicitly selected) folder. Request body is exactly
// {schema_version:1}; response {schema_version, group_id, path, root_group_id, writable, updated_at}.
export const ACTIVE_GROUP_ROUTE = "/api/v1/active-group";

// Read-only folder list for the "自选目录" picker, gated by its own feature. Request body is exactly
// {schema_version:1}; response {schema_version, groups_version, nodes}, each node only
// {group_id, name, kind, parent_id, root_group_id, writable}.
export const GROUP_PICKER_FEATURE = "url-jobs-group-picker-v1";
export const GROUPS_ROUTE = "/api/v1/groups";

// The three destination choices shown as radios; the last one used is remembered in storage.
export const CHOICES = Object.freeze(["inbox", "current", "custom"]);
export const MAX_HISTORY = 10;

// Enqueue field and its values. Omitting the field keeps the legacy (1.3.x) request semantics.
export const DESTINATION_MODE_FIELD = "destination_mode";
export const DESTINATION_MODE = Object.freeze({ inbox: "inbox", group: "selected_group" });

// Podcast receipt `enrichment.placement` (contract: present on completed enrichment). It describes what this
// job did, not the item's live location: later moves never rewrite it. Unknown values are ignored.
export const PLACEMENTS = Object.freeze(["selected_group", "existing_locations_preserved", "unfiled"]);
export const placementOf = (receipt) => PLACEMENTS.includes(receipt?.enrichment?.placement) ? receipt.enrichment.placement : null;

const GROUP_ID = /^group_[A-Za-z0-9_]{1,122}$/;
export const isGroupId = (value) => typeof value === "string" && GROUP_ID.test(value);

// Destination snapshot stored in a job: { mode: "inbox" } or { mode: "group", group_id, path }.
// Only these fields go on the wire; `path` is a display snapshot and is never sent.
export function destinationFields(destination) {
  if (destination?.mode === "inbox") return { [DESTINATION_MODE_FIELD]: DESTINATION_MODE.inbox };
  return { [DESTINATION_MODE_FIELD]: DESTINATION_MODE.group, target_group_id: destination.group_id };
}
export const validDestination = (destination) => destination?.mode === "inbox" ||
  (destination?.mode === "group" && isGroupId(destination.group_id));

// the Mac's current folder as a target: any writable folder or writable library root, at any depth.
// null (Inbox / all items / search), read-only, or no longer resolvable selections are refused.
export function resolveActiveGroup(body) {
  if (!body || typeof body !== "object" || !("group_id" in body)) return { state: "error", code: "unknown" };
  const path = Array.isArray(body.path) ? body.path.filter((name) => typeof name === "string").slice(0, 32) : [];
  if (body.group_id === null) return { state: "blocked", reason: "none", path };
  if (!isGroupId(body.group_id) || !path.length) return { state: "blocked", reason: "invalid", path };
  if (body.writable !== true) return { state: "blocked", reason: "readonly", path };
  return { state: "ok", group_id: body.group_id, path };
}

// The /api/v1/groups list as a tree in display order (roots, then children by name, depth first).
// Any writable library root or folder at any depth is a legal target; read-only ones are shown, not
// selectable. Nodes not reachable from a root are dropped. Returns a Map group_id -> node, or null.
export function groupTree(body) {
  if (!body || !Array.isArray(body.nodes)) return null;
  const byId = new Map();
  for (const n of body.nodes) {
    if (!n || !isGroupId(n.group_id) || typeof n.name !== "string" || !(n.parent_id === null || isGroupId(n.parent_id))) continue;
    byId.set(n.group_id, { group_id: n.group_id, name: n.name, parent_id: n.parent_id, writable: n.writable === true, children: [] });
  }
  const roots = [];
  for (const n of byId.values()) {
    if (n.parent_id === null) roots.push(n);
    else byId.get(n.parent_id)?.children.push(n);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const nodes = new Map();
  const walk = (n, path) => {
    if (nodes.has(n.group_id) || path.length >= 32) return;
    const own = [...path, n.name];
    nodes.set(n.group_id, { group_id: n.group_id, path: own, depth: path.length, writable: n.writable });
    for (const child of n.children.sort(byName)) walk(child, own);
  };
  for (const root of roots.sort(byName)) walk(root, []);
  return nodes;
}

// The remembered "自选目录" checked against the current list (`groups` is what loadGroups returned).
export function resolveCustom(custom, groups) {
  if (groups?.state === "closed" || groups?.state === "error") return groups;
  if (!isGroupId(custom?.group_id)) return { state: "blocked", reason: "unset", path: [] };
  const saved = Array.isArray(custom.path) ? custom.path : [];
  if (groups?.state !== "ok") return { state: "loading", path: saved };
  const node = groups.nodes.get(custom.group_id);
  if (!node) return { state: "blocked", reason: "missing", path: saved };
  if (!node.writable) return { state: "blocked", reason: "readonly", path: node.path };
  return { state: "ok", group_id: node.group_id, path: node.path };
}

// Recently used folders: only group_id plus the path at that time (display only), newest first,
// no duplicates, at most MAX_HISTORY.
const cleanPath = (path) => Array.isArray(path) ? path.filter((name) => typeof name === "string").slice(0, 32) : [];
export function pushHistory(history, entry, max = MAX_HISTORY) {
  const rest = (Array.isArray(history) ? history : []).filter((h) => isGroupId(h?.group_id) && h.group_id !== entry.group_id);
  return [entry, ...rest].map((h) => ({ group_id: h.group_id, path: cleanPath(h.path) })).slice(0, max);
}
// Shown only after checking against the current list: gone entries are hidden, read-only ones are
// marked, renamed ones show their current path.
export function reconcileHistory(history, groups) {
  if (groups?.state !== "ok") return [];
  return (Array.isArray(history) ? history : []).flatMap((h) => {
    const node = isGroupId(h?.group_id) && groups.nodes.get(h.group_id);
    return node ? [{ group_id: node.group_id, path: node.path, writable: node.writable }] : [];
  }).slice(0, MAX_HISTORY);
}
