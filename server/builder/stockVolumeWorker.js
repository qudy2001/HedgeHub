import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { inflateSync } from "node:zlib";
import { createProfileAccumulator } from "../../shared/stockVolumeProfile.js";
let db;
try {
  db = new Database(workerData.filename, { readonly: true });
  const read = db.prepare(
      "SELECT data FROM stock_volume_chunks WHERE cache_key=?",
    ),
    acc = createProfileAccumulator(workerData.settings.buckets),
    seen = new Set();
  for (const key of new Set(workerData.keys)) {
    const chunk = read.get(key);
    if (!chunk) continue;
    for (const b of JSON.parse(inflateSync(chunk.data).toString())) {
      if (
        b.date < workerData.settings.from ||
        b.date > workerData.settings.to ||
        seen.has(b.time)
      )
        continue;
      seen.add(b.time);
      acc.add(b);
    }
  }
  parentPort.postMessage(acc.result());
} catch (e) {
  parentPort.postMessage({ error: e.message });
} finally {
  db?.close();
}
