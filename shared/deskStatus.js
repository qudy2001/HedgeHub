// Daily desk status: what the four AI lanes (see shared/aiScheduleTemplates.js) last wrote, read back from the topics.
// HedgeHub cannot tell the platforms apart on the wire (they share one API key), so everything here comes from the
// summary header each desk prompt writes: "As of <time> by <Platform>. Stage: <stage>. Next check: <date or none>."
import { DESK_LANES, deskAnchors, deskLane } from "./aiScheduleTemplates.js";
import { topicSentiment } from "./marketTopics.js";

export const DESK_STAGES = ["standing", "new", "developing", "active", "fading", "resolved"];
// The order the lanes run in on a trading day; ChatGPT goes last because it reads the other three.
export const DESK_LANE_ORDER = ["gemini", "grok", "claude", "chatgpt"];
// A lane whose last write is older than this is reported late (a Friday run must still count on Monday morning).
export const DESK_LATE_AFTER_DAYS = 3;
const ARCHIVE_AFTER_DAYS = 30;
// The prompts re-save an unchanged topic after about 10 days, so one that is within two weeks of archiving was missed.
const ARCHIVE_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

const LANE_BY_NAME = Object.fromEntries(Object.entries(DESK_LANES).map(([id, lane]) => [lane.name.toLowerCase(), id]));
const LANE_NAMES = Object.values(DESK_LANES).map((lane) => lane.name).join("|");

// "<Lane>: <subject> - <what to check>; <Lane>: ..." A request may contain a semicolon of its own, so a piece that does
// not open with a lane name belongs to the request before it.
function parseFlags(summary) {
  const at = summary.search(/\bFlags:/);
  if (at < 0) return [];
  const body = summary.slice(at + "Flags:".length).trim().replace(/\.$/, "");
  if (!body || /^none\b/i.test(body)) return [];
  const flags = [];
  for (const piece of body.split(";").map((part) => part.trim()).filter(Boolean)) {
    const addressed = piece.match(new RegExp(`^(${LANE_NAMES})\\s*:\\s*(.+)$`, "is"));
    if (addressed) flags.push({ to: LANE_BY_NAME[addressed[1].toLowerCase()], text: addressed[2].trim() });
    else if (flags.length) flags[flags.length - 1].text += `; ${piece}`;
  }
  return flags;
}

// The header and the flags of one summary. Fields the summary does not carry come back null.
export function parseDeskSummary(summary) {
  const text = String(summary ?? "");
  const head = text.slice(0, 200);
  const by = head.match(new RegExp(`\\bby (${LANE_NAMES})\\b`, "i"));
  const stage = head.match(/\bStage:\s*([a-z]+)/i)?.[1]?.toLowerCase();
  const next = head.match(/\bNext check:\s*(\d{4}-\d{2}-\d{2}|none)/i)?.[1]?.toLowerCase();
  return {
    by: by ? LANE_BY_NAME[by[1].toLowerCase()] : null,
    stage: DESK_STAGES.includes(stage) ? stage : null,
    nextCheck: next ?? null,
    flags: parseFlags(text)
  };
}

// Next check dates are written in US Eastern time, so "today" is the Eastern calendar day.
function easternDate(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

function sameTitle(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

// topics: rows as returned by the market-topic APIs (active and archived). anchors: deskAnchors(), with the user's own
// hub title when they changed it. Returns the four lanes in run order plus every open flag.
export function deskStatus(topics = [], { now = new Date(), anchors = deskAnchors() } = {}) {
  const today = easternDate(now);
  const rows = topics.map((topic) => {
    const header = parseDeskSummary(topic.summary);
    const updated = Date.parse(topic.updatedAt ?? "");
    const ageDays = Number.isFinite(updated) ? (now.getTime() - updated) / DAY_MS : null;
    const lane = deskLane(topic);
    const archived = topic.status === "archived";
    const resolved = header.stage === "resolved";
    return {
      id: topic.id,
      title: topic.title,
      weight: Number(topic.weight),
      sentiment: topicSentiment(topic),
      lane,
      archived,
      updatedAt: topic.updatedAt ?? null,
      ageDays,
      writtenBy: header.by,
      stage: header.stage,
      nextCheck: header.nextCheck,
      flags: header.flags,
      anchor: sameTitle(topic.title, anchors[lane]),
      // Written before the desk existed, or by a prompt that is not a desk prompt: no lane has adopted it yet.
      legacy: !header.by,
      // Another platform wrote into this lane.
      foreign: Boolean(header.by) && header.by !== lane,
      due: !archived && !resolved && /^\d{4}/.test(header.nextCheck ?? "") && header.nextCheck <= today,
      archivesInDays: archived || ageDays === null ? null : Math.max(0, Math.ceil(ARCHIVE_AFTER_DAYS - ageDays)),
      archivingSoon: !archived && !resolved && ageDays !== null && ageDays >= ARCHIVE_AFTER_DAYS - ARCHIVE_WARNING_DAYS
    };
  });

  const flags = rows
    .filter((row) => row.anchor && !row.archived && row.writtenBy === row.lane)
    .flatMap((row) => row.flags.map((flag) => ({ from: row.lane, to: flag.to, text: flag.text })));

  const lanes = DESK_LANE_ORDER.map((id) => {
    const mine = rows.filter((row) => row.lane === id);
    const live = mine.filter((row) => !row.archived);
    const written = mine.filter((row) => row.writtenBy === id && row.updatedAt);
    const lastWrite = written.reduce((latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest), null);
    const ageDays = lastWrite ? (now.getTime() - Date.parse(lastWrite)) / DAY_MS : null;
    const anchor = live.find((row) => row.anchor) ?? null;
    return {
      id,
      name: DESK_LANES[id].name,
      duty: DESK_LANES[id].duty,
      anchorTitle: anchors[id],
      // "missing": never written; "adopted": written by this lane's desk prompt; "legacy": exists, but not yet rewritten.
      anchorState: !anchor ? "missing" : anchor.writtenBy === id ? "adopted" : "legacy",
      lastWrite,
      ageDays,
      health: lastWrite === null ? "never" : ageDays > DESK_LATE_AFTER_DAYS ? "late" : "ok",
      topics: live.sort(
        (a, b) => Number(b.due) - Number(a.due) || Number(b.archivingSoon) - Number(a.archivingSoon) || b.weight - a.weight
      ),
      counts: {
        live: live.length,
        unresolved: live.filter((row) => row.stage !== "resolved").length,
        due: live.filter((row) => row.due).length,
        legacy: live.filter((row) => row.legacy).length,
        archivingSoon: live.filter((row) => row.archivingSoon).length
      },
      inbox: flags.filter((flag) => flag.to === id)
    };
  });

  return { today, lanes, flags, started: lanes.some((lane) => lane.health !== "never") };
}
