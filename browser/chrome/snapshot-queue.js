// Keep the exact immutable binary request before sending. A timeout, worker
// suspension or lost receipt replays it on the next explicit capture click.
export async function pendingSnapshot(action, key, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("memex-snapshots-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("pending");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("snapshot_storage_failed"));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("pending", action === "get" ? "readonly" : "readwrite");
      const store = tx.objectStore("pending");
      const request = action === "get" ? store.get(key) : action === "delete" ? store.delete(key) : store.put(value, key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(new Error("snapshot_storage_failed"));
      tx.onabort = () => reject(new Error("snapshot_storage_failed"));
    });
  } finally { db.close(); }
}
