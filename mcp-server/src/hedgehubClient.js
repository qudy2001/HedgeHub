const HEDGEHUB_API_URL = String(process.env.HEDGEHUB_API_URL ?? "").trim().replace(/\/+$/, "");
const HEDGEHUB_API_KEY = String(process.env.HEDGEHUB_API_KEY ?? "").trim();

if (!HEDGEHUB_API_URL) {
  throw new Error("HEDGEHUB_API_URL environment variable is required");
}
if (!HEDGEHUB_API_KEY) {
  throw new Error("HEDGEHUB_API_KEY environment variable is required");
}

export async function callHedgeHub(method, path, body) {
  const response = await fetch(`${HEDGEHUB_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": HEDGEHUB_API_KEY
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(
      `HedgeHub returned non-JSON response (${response.status}) for ${method} ${path}: ${text.slice(0, 500)}`
    );
  }

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || `HedgeHub request failed (${response.status}) for ${method} ${path}`);
  }

  return payload;
}
