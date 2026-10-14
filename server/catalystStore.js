import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { timestampIso } from "./quoteQuality.js";
import { CATALYST_CATEGORIES, CATALYST_DATE_STATUSES, catalystFilePath, safeSourceUrl } from "./researchCatalysts.js";

// Admin-side editor for the curated catalyst calendar that researchCatalysts.curatedCatalysts() reads.
// The JSON file format is unchanged, so entry research and the Builder pick up edits without changes.

const DAY_MS = 86_400_000;
const REVIEW_MAX_AGE_DAYS = 7; // same rule buildCatalystChecklist() uses to raise a coverage gap
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;
const MAX_SYMBOLS = 20;

export class CatalystError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CatalystError";
    this.status = status;
  }
}

function strictDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

function parseSymbols(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[\s,;]+/);
  return [...new Set(parts.map((part) => String(part).trim().toUpperCase()).filter(Boolean))];
}

function boundedText(value, label, max, { required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) {
    throw new CatalystError(`${label} is required`);
  }
  if (text.length > max) {
    throw new CatalystError(`${label} must be at most ${max} characters`);
  }
  return text;
}

// Validates a create/update body. Updates are partial: fields that are absent keep their existing value.
export function normalizeCatalystInput(body = {}, { existing = null, now = new Date() } = {}) {
  const pick = (key) => (body[key] !== undefined ? body[key] : existing?.[key]);

  const symbols = parseSymbols(pick("symbols"));
  if (!symbols.length) {
    throw new CatalystError("at least one symbol is required");
  }
  if (symbols.length > MAX_SYMBOLS) {
    throw new CatalystError(`at most ${MAX_SYMBOLS} symbols are allowed`);
  }
  const badSymbol = symbols.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (badSymbol) {
    throw new CatalystError(`invalid symbol: ${badSymbol}`);
  }

  const category = pick("category") ?? "announcement";
  if (!CATALYST_CATEGORIES.includes(category)) {
    throw new CatalystError(`category must be one of ${CATALYST_CATEGORIES.join(", ")}`);
  }
  const dateStatus = pick("dateStatus") ?? "unconfirmed";
  if (!CATALYST_DATE_STATUSES.includes(dateStatus)) {
    throw new CatalystError(`dateStatus must be one of ${CATALYST_DATE_STATUSES.join(", ")}`);
  }

  const rawDate = pick("date");
  const date = rawDate == null || String(rawDate).trim() === "" ? null : strictDate(rawDate);
  if (rawDate != null && String(rawDate).trim() !== "" && !date) {
    throw new CatalystError("date must be a valid YYYY-MM-DD date");
  }
  if (!date && dateStatus !== "unconfirmed") {
    throw new CatalystError("date is required when the date status is confirmed or estimated");
  }

  const sourceUrl = safeSourceUrl(String(pick("sourceUrl") ?? "").trim());
  if (!sourceUrl) {
    throw new CatalystError("sourceUrl must be a valid http(s) URL; events without a source are ignored by research");
  }

  // New events count as verified when saved; edits keep the old stamp unless the admin re-verifies the source.
  const verifiedAt = !existing || body.markVerified === true ? now.toISOString() : timestampIso(existing.verifiedAt);

  return {
    ...(existing ?? {}),
    id: existing?.id ? String(existing.id) : crypto.randomUUID(),
    symbols,
    title: boundedText(pick("title"), "title", 500, { required: true }),
    category,
    date,
    dateStatus,
    source: boundedText(pick("source"), "source", 200),
    sourceUrl,
    verifiedAt,
    note: boundedText(pick("note"), "note", 1000)
  };
}

async function readPayload() {
  const file = catalystFilePath();
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { file, exists: false, payload: { events: [] } };
    }
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // Never overwrite a file we cannot parse; it may be hand-edited and hold the only copy.
    throw new CatalystError(`Catalyst file ${file} is not valid JSON; fix or remove it first`, 500);
  }
  if (!payload || !Array.isArray(payload.events)) {
    throw new CatalystError("Catalyst file must contain an events array", 500);
  }
  return { file, exists: true, payload };
}

async function writePayload(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  try {
    await fs.rename(tmp, file); // atomic, so readers never see a half-written file
  } catch (error) {
    // A file that is itself a bind mount cannot be replaced; fall back to writing in place.
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
    await fs.writeFile(file, text, "utf8");
    await fs.rm(tmp, { force: true });
  }
}

// Hand-maintained files may omit event ids; such events are addressed by position until the next write assigns ids.
const eventId = (event, index) => (event.id ? String(event.id) : `legacy-${index}`);

function buildState({ file, exists, payload }, now) {
  const reviewedAt = timestampIso(payload.reviewedAt);
  const reviewedMs = reviewedAt ? Date.parse(reviewedAt) : NaN;
  const reviewStale = !reviewedAt || now.getTime() - reviewedMs > REVIEW_MAX_AGE_DAYS * DAY_MS || reviewedMs > now.getTime();
  return {
    events: payload.events.map((event, index) => ({
      ...event,
      id: eventId(event, index),
      symbols: Array.isArray(event.symbols) ? event.symbols : []
    })),
    reviewedAt,
    reviewStale,
    reviewMaxAgeDays: REVIEW_MAX_AGE_DAYS,
    exists,
    filePath: file
  };
}

// Serialises read-modify-write cycles inside this process so concurrent admin requests cannot lose updates.
let queue = Promise.resolve();
function serialize(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function assignMissingIds(events) {
  return events.map((event) => (event.id ? event : { ...event, id: crypto.randomUUID() }));
}

async function mutate(change, now = new Date()) {
  return serialize(async () => {
    const current = await readPayload();
    const result = change(current.payload);
    const payload = { ...current.payload, events: assignMissingIds(result.events ?? current.payload.events) };
    if (result.reviewedAt !== undefined) {
      payload.reviewedAt = result.reviewedAt;
    }
    await writePayload(current.file, payload);
    return { ...buildState({ file: current.file, exists: true, payload }, now), changed: result.changed ?? null };
  });
}

const findIndex = (events, id) => events.findIndex((event, index) => eventId(event, index) === String(id));

export async function listCatalysts(now = new Date()) {
  return buildState(await readPayload(), now);
}

export function createCatalyst(body, now = new Date()) {
  return mutate((payload) => {
    const event = normalizeCatalystInput(body, { now });
    return { events: [...payload.events, event], changed: event };
  }, now);
}

export function updateCatalyst(id, body, now = new Date()) {
  return mutate((payload) => {
    const index = findIndex(payload.events, id);
    if (index < 0) {
      throw new CatalystError("Catalyst event not found", 404);
    }
    const existing = { ...payload.events[index], id: payload.events[index].id ?? crypto.randomUUID() };
    const event = normalizeCatalystInput(body, { existing, now });
    const events = [...payload.events];
    events[index] = event;
    return { events, changed: event };
  }, now);
}

export function deleteCatalyst(id, now = new Date()) {
  return mutate((payload) => {
    const index = findIndex(payload.events, id);
    if (index < 0) {
      throw new CatalystError("Catalyst event not found", 404);
    }
    return { events: payload.events.filter((_, position) => position !== index) };
  }, now);
}

// "Mark reviewed": the admin confirms the whole calendar was rechecked against original sources.
export function markCatalystsReviewed(now = new Date()) {
  return mutate(() => ({ reviewedAt: now.toISOString() }), now);
}
