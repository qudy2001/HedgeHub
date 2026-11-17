// The Daily desk's wire format: the words the desk prompts write into topic titles and summaries and that HedgeHub
// reads back (shared/deskStatus.js). The prompts exist in English and in Chinese (shared/aiScheduleTemplates.js and
// shared/aiScheduleTemplates.zh.js); both vocabularies live here so that a prompt and its parser cannot drift apart.
// Readers accept either language whatever the prompt language is: a model may mix them, and the topic list may hold
// topics written under both.
import { topicTitleKey } from "./marketTopics.js";

export const DESK_PLATFORMS = { chatgpt: "ChatGPT", grok: "Grok", claude: "Claude", gemini: "Gemini" };
export const DESK_STAGES = ["standing", "new", "developing", "active", "fading", "resolved"];
export const DESK_LANGUAGES = ["en", "zh"];

export const DESK_WORDS = {
  en: {
    prefixes: { social: "Social:", news: "News:", event: "Event:", thesis: "Thesis:", research: "Research:" },
    stages: { standing: "standing", new: "new", developing: "developing", active: "active", fading: "fading", resolved: "resolved" },
    by: (platform) => `by ${platform}`,
    stage: "Stage",
    nextCheck: "Next check",
    none: "none",
    flags: "Flags",
    anchors: {
      chatgpt: "US market risk regime",
      grok: "Social: X market mood",
      gemini: "News: market drivers today",
      claude: "Research: deep-dive log"
    }
  },
  zh: {
    // Half-width colon on purpose: it is what the prompts ask for. A full-width one is folded when titles are compared.
    prefixes: { social: "社交:", news: "新闻:", event: "事件:", thesis: "专题:", research: "研究:" },
    stages: { standing: "长期", new: "新增", developing: "发酵中", active: "活跃", fading: "降温", resolved: "已结束" },
    // The Chinese prompts call each lane by its role instead of by the platform it runs on, so a lane's prompt can be
    // pasted into any platform. Summaries then say "由宏观策略师撰写"; the parser reads a role or a platform name.
    roles: { chatgpt: "宏观策略师", grok: "舆情分析师", claude: "深度研究员", gemini: "新闻编辑" },
    by: (name) => `由${name}撰写`,
    stage: "阶段",
    nextCheck: "下次检查",
    none: "无",
    flags: "提醒",
    anchors: {
      chatgpt: "美股大势研判",
      grok: "社交: X 市场情绪",
      gemini: "新闻: 今日要闻",
      claude: "研究: 深度研究日志"
    }
  }
};

const PREFIX_LANES = { social: "grok", news: "gemini", event: "gemini", thesis: "claude", research: "claude" };
const PREFIXES = DESK_LANGUAGES.flatMap((language) =>
  Object.entries(DESK_WORDS[language].prefixes).map(([kind, prefix]) => [topicTitleKey(prefix), PREFIX_LANES[kind]])
);

// Which lane owns a topic: { title, category } -> "chatgpt" | "grok" | "claude" | "gemini". The title prefix decides
// first (in either language), then the category.
export function deskLane(topic) {
  const title = topicTitleKey(topic?.title);
  const prefixed = PREFIXES.find(([prefix]) => title.startsWith(prefix));
  if (prefixed) return prefixed[1];
  if (topic?.category === "social") return "grok";
  if (topic?.category === "ticker") return "claude";
  return "chatgpt";
}

// The anchor title each lane's prompt writes, in the prompt's language. `values.hubAnchor` is the user's own title
// for ChatGPT's overall-view topic.
export function deskAnchors(values = {}, language = "en") {
  const words = DESK_WORDS[language] ?? DESK_WORDS.en;
  return { ...words.anchors, chatgpt: values.hubAnchor || words.anchors.chatgpt };
}

// Every title that counts as a lane's anchor: both languages, plus the user's own hub title. A desk that switched
// language keeps the anchor it already had (topics are never renamed), so a reader must accept either. The first title
// of each lane is the one a prompt in `language` creates when the lane has no anchor yet.
export function deskAnchorTitles(values = {}, language = "en") {
  const languages = [language, ...DESK_LANGUAGES].filter((item, index, all) => item in DESK_WORDS && all.indexOf(item) === index);
  return Object.fromEntries(
    Object.keys(DESK_PLATFORMS).map((lane) => [
      lane,
      [...new Set([lane === "chatgpt" ? values.hubAnchor : null, ...languages.map((item) => DESK_WORDS[item].anchors[lane])].filter(Boolean))]
    ])
  );
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const either = (pick) => DESK_LANGUAGES.map((language) => escapeRegExp(pick(DESK_WORDS[language]))).join("|");
// A lane is named by its platform or, in Chinese summaries, by its role.
const LANE_NAMES = [...Object.entries(DESK_PLATFORMS), ...Object.entries(DESK_WORDS.zh.roles)];
const PLATFORM_NAMES = LANE_NAMES.map(([, name]) => escapeRegExp(name)).join("|");
const LANE_BY_NAME = Object.fromEntries(LANE_NAMES.map(([id, name]) => [name.toLowerCase(), id]));
const STAGE_BY_WORD = Object.fromEntries(
  DESK_LANGUAGES.flatMap((language) => Object.entries(DESK_WORDS[language].stages).map(([stage, word]) => [word, stage]))
);
// Longest first, so that no stage word is cut short by another.
const STAGE_WORDS = Object.keys(STAGE_BY_WORD).sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");

const BY = new RegExp(`(?:\\bby|由)\\s*(${PLATFORM_NAMES})`, "i");
const STAGE = new RegExp(`(?:${either((words) => words.stage)})\\s*:\\s*(${STAGE_WORDS})`, "i");
const NEXT_CHECK = new RegExp(`(?:${either((words) => words.nextCheck)})\\s*:\\s*(\\d{4}-\\d{2}-\\d{2}|${either((words) => words.none)})`, "i");
const FLAGS = new RegExp(`(?:${either((words) => words.flags)})\\s*:`, "i");
const NONE = new RegExp(`^(?:${either((words) => words.none)})(?![\\p{L}\\p{N}])`, "iu");
const ADDRESSED = new RegExp(`^(${PLATFORM_NAMES})\\s*:\\s*(.+)$`, "is");

// "<Lane>: <subject> - <what to check>; <Lane>: ..." A request may contain a semicolon of its own, so a piece that does
// not open with a lane name belongs to the request before it.
function parseFlags(text) {
  const found = FLAGS.exec(text);
  if (!found) return [];
  const body = text.slice(found.index + found[0].length).trim().replace(/[.。]$/, "");
  if (!body || NONE.test(body)) return [];
  const flags = [];
  for (const piece of body.split(";").map((part) => part.trim()).filter(Boolean)) {
    const addressed = ADDRESSED.exec(piece);
    if (addressed) flags.push({ to: LANE_BY_NAME[addressed[1].toLowerCase()], text: addressed[2].trim() });
    else if (flags.length) flags[flags.length - 1].text += `; ${piece}`;
  }
  return flags;
}

// The header and the flags of one summary, in either language:
//   "As of 2026-11-14 08:30 ET by ChatGPT. Stage: active. Next check: 2026-11-17."
//   "截至 2026-11-14 08:30 ET，由宏观策略师撰写。阶段：活跃。下次检查：2026-11-17。"
// Fields the summary does not carry come back null; stage and next check are returned in their English form.
export function parseDeskSummary(summary) {
  // NFKC folds full-width colons, semicolons and letters, so one set of patterns reads both ways of typing.
  const text = String(summary ?? "").normalize("NFKC");
  const head = text.slice(0, 200);
  const by = BY.exec(head);
  const stage = STAGE.exec(head)?.[1];
  const next = NEXT_CHECK.exec(head)?.[1]?.toLowerCase();
  return {
    by: by ? LANE_BY_NAME[by[1].toLowerCase()] : null,
    stage: stage ? (STAGE_BY_WORD[stage] ?? STAGE_BY_WORD[stage.toLowerCase()] ?? null) : null,
    nextCheck: next ? (/^\d/.test(next) ? next : "none") : null,
    flags: parseFlags(text)
  };
}

// The header line a desk prompt asks for, used in the prompts' SUMMARY rule and in tests.
export function deskHeaderExample(language, { time, platform, stage, nextCheck }) {
  const words = DESK_WORDS[language];
  return language === "zh"
    ? `截至 ${time}，${words.by(platform)}。${words.stage}：${stage}。${words.nextCheck}：${nextCheck}。`
    : `As of ${time} ${words.by(platform)}. ${words.stage}: ${stage}. ${words.nextCheck}: ${nextCheck}.`;
}
