import { useEffect, useState } from "react";
import { validateStockProfile } from "../../shared/stockVolumeProfile.js";
async function request(path, body) {
  const r = await fetch("/api/builder/stock-volume" + path, {
    credentials: "same-origin",
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Could not load stock volume");
  return data;
}
export default function useStockVolumeProfile({
  active,
  symbol,
  buckets,
  interval,
  days,
  demo,
  dailyBars,
  refresh,
}) {
  const [state, setState] = useState({});
  const bucketKey = JSON.stringify(
      buckets.map((b, i) => ({
        key: String(i),
        lowStrike: b.lowStrike,
        highStrike: b.highStrike,
      })),
    ),
    key = JSON.stringify([symbol, bucketKey, interval, days, demo, refresh]);
  useEffect(() => {
    if (!active || !symbol || !buckets.length) {
      setState({});
      return;
    }
    let disposed = false,
      timer,
      jobId,
      worker;
    const update = (patch) => {
      if (!disposed) setState((s) => ({ ...s, ...patch, key }));
    };
    setState({ key, loading: true, progress: 0 });
    const cancel = () => {
      if (jobId) request("/" + jobId + "/cancel", {}).catch(() => {});
    };
    try {
      const settings = validateStockProfile({
        symbol,
        interval,
        days,
        buckets: JSON.parse(bucketKey),
      });
      if (demo) {
        worker = new Worker(
          new URL("./stockVolumeWorker.js", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = ({ data }) => {
          update(
            data.error
              ? { error: data.error, loading: false }
              : { result: data.result, loading: false },
          );
          worker.terminate();
        };
        worker.onerror = () => {
          update({
            error: "Could not calculate sample volume",
            loading: false,
          });
          worker.terminate();
        };
        worker.postMessage({ settings, bars: dailyBars ?? [] });
      } else {
        const poll = async () => {
          try {
            const j = await request("/" + jobId);
            if (disposed) return;
            if (j.status === "completed") {
              update({ loading: false, result: j.result });
              return;
            }
            if (["failed", "cancelled"].includes(j.status)) {
              update({
                loading: false,
                error: j.error || "History request cancelled",
              });
              return;
            }
            update({
              progress: j.progress,
              processed: j.processed,
              total: j.total,
              cacheHits: j.cacheHits,
              waiting: j.waiting,
              processing: j.status === "processing",
            });
            timer = setTimeout(poll, 1000);
          } catch (e) {
            update({ loading: false, error: e.message });
          }
        };
        request("", settings)
          .then((j) => {
            jobId = j.id;
            if (disposed) {
              cancel();
              return;
            }
            void poll();
          })
          .catch((e) => update({ loading: false, error: e.message }));
      }
    } catch (e) {
      update({ loading: false, error: e.message });
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
      worker?.terminate();
      cancel();
    };
  }, [active, symbol, bucketKey, interval, days, demo, dailyBars, refresh]);
  return state.key === key && active ? state : {};
}
