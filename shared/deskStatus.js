// Daily desk status: what the four AI lanes (see shared/aiScheduleTemplates.js) last wrote, read back from the topics.
// HedgeHub cannot tell the platforms apart on the wire (they share one API key), so everything here comes from the
// summary header each desk prompt writes: "As of <time> by <Platform>. Stage: <stage>. Next check: <date or none>."
// (or its Chinese form; shared/deskProtocol.js reads both).
import { DESK_LANES } from "./aiScheduleTemplates.js";
import { DESK_STAGES, deskAnchorTitles, deskLane, parseDeskSummary } from "./deskProtocol.js";
import { topicSentiment, topicTitleKey } from "./marketTopics.js";

export { DESK_STAGES, parseDeskSummary };
// The order the lanes run in on a trading day; ChatGPT goes last because it reads the other three.
export const DESK_LANE_ORDER = ["gemini", "grok", "claude", "chatgpt"];
// A lane whose last write is older than this is reported late (a Friday run must still count on Monday morning).
export const DESK_LATE_AFTER_DAYS = 3;
const ARCHIVE_AFTER_DAYS = 30;
// The prompts re-save an unchanged topic after about 10 days, so one that is within two weeks of archiving was missed.
const ARCHIVE_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

// Next check dates are written in US Eastern time, so "today" is the Eastern calendar day.
function easternDate(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

// topics: rows as returned by the market-topic APIs (active and archived). anchors: per lane, the title or titles that
// count as its anchor (deskAnchorTitles(): English and Chinese, plus the user's own hub title when they changed it).
// Returns the four lanes in run order plus every open flag.
export function deskStatus(topics = [], { now = new Date(), anchors = deskAnchorTitles() } = {}) {
  const today = easternDate(now);
  const anchorKeys = Object.fromEntries(Object.entries(anchors).map(([lane, titles]) => [lane, [titles].flat().map(topicTitleKey)]));
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
      anchor: (anchorKeys[lane] ?? []).includes(topicTitleKey(topic.title)),
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
      // The anchor as it is titled in the list; before the first run, the title the prompt will give it.
      anchorTitle: anchor?.title ?? [anchors[id]].flat()[0],
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
