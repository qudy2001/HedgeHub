import crypto from "node:crypto";

// Tiny in-memory store for short-lived background jobs that the UI polls (so a slow scan, for example one
// that is waiting out a provider rate limit, never holds an HTTP request open).
export function createJobStore({ ttlMs = 15 * 60_000, maxRunningPerUser = 2, now = () => Date.now() } = {}) {
  const jobs = new Map();

  function sweep() {
    for (const [id, job] of jobs) {
      if (job.status !== "running" && now() - job.updatedAt > ttlMs) {
        jobs.delete(id);
      }
    }
  }

  function start(userId, task) {
    sweep();
    const running = [...jobs.values()].filter((job) => job.userId === userId && job.status === "running");
    if (running.length >= maxRunningPerUser) {
      const error = new Error("Too many scans are already running. Wait for them to finish.");
      error.status = 429;
      throw error;
    }

    const job = { id: crypto.randomUUID(), userId, status: "running", result: null, error: null, createdAt: now(), updatedAt: now() };
    jobs.set(job.id, job);
    Promise.resolve()
      .then(task)
      .then((result) => {
        job.result = result;
        job.status = "completed";
      })
      .catch((error) => {
        job.error = error?.message ?? String(error);
        job.status = "failed";
      })
      .finally(() => {
        job.updatedAt = now();
      });
    return job;
  }

  function get(userId, id) {
    const job = jobs.get(id);
    return job && job.userId === userId ? job : null;
  }

  return { start, get, size: () => jobs.size };
}
