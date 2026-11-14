// Turns a TradingAgents report (loose markdown: "**Label**: value" lines,
// paragraphs, bullet lists, headings, pipe tables) into blocks the UI can lay
// out. Pure text in, plain data out; nothing here produces HTML.

// "**Label**: value", and the form Chinese writers favour, with the colon inside the bold: "**标签：** 内容".
const FIELD = /^\*\*(.+?)\*\*\s*[:：]\s*(.*)$/;
const FIELD_COLON_INSIDE = /^\*\*(.+?)\s*[:：]\*\*\s*(.*)$/;
const HAN = /\p{Script=Han}/u;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// A value this short sits in the key-facts grid; anything longer reads as prose.
export const SHORT_VALUE = 60;
// Width in Latin-letter columns: a Chinese character takes about two, so 30 of them fill what 60 letters do.
export const displayWidth = (text) =>
  [...String(text ?? "")].reduce((width, char) => width + (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(char) ? 2 : 1), 0);
// "en" or "zh": the language a report or a piece of agent text was written in.
export const textLanguage = (text) => (HAN.test(String(text ?? "")) ? "zh" : "en");

// Report fields whose value is one of the five ratings.
export const isRatingField = (label) => /^(rating|recommendation|action|评级|建议|操作)$/i.test(String(label ?? "").trim());
export const isKeywordField = (label) => /^(keywords?|关键词)$/i.test(String(label ?? "").trim());
export const splitKeywords = (text) =>
  String(text ?? "")
    .split(/\s*[,，、;；]\s*/)
    .map((tag) => tag.trim())
    .filter(Boolean);

const cells = (line) =>
  TABLE_ROW.exec(line)[1]
    .split("|")
    .map((cell) => cell.trim());

// "Title | Trigger: x | Entry: 1 | Notes: ..." becomes a title plus labelled parts.
export function parseListItem(text) {
  const segments = text.split(/\s+\|\s+/);
  if (segments.length < 3) return { text };
  const fields = segments.slice(1).map((segment) => {
    const match = /^(\p{L}[\p{L} /%-]{0,30}?)\s*[:：]\s*(.+)$/su.exec(segment);
    return match ? { label: match[1], value: match[2] } : null;
  });
  if (fields.filter(Boolean).length < 2) return { text };
  return {
    title: segments[0],
    fields: fields.map((field, i) => field ?? { label: "", value: segments[i + 1] }),
  };
}

export function parseAgentReport(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const field = FIELD.exec(line.trim()) ?? FIELD_COLON_INSIDE.exec(line.trim());
    if (field) {
      flush();
      const [, label, value] = field;
      if (!value) blocks.push({ type: "heading", level: 3, text: label });
      // Keywords are always shown as tags, however short the line is.
      else if (displayWidth(value) <= SHORT_VALUE && !isKeywordField(label)) {
        const last = blocks.at(-1);
        if (last?.type === "facts") last.items.push({ label, value });
        else blocks.push({ type: "facts", items: [{ label, value }] });
      } else blocks.push({ type: "section", label, text: value });
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      i -= 1;
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      const item = parseListItem(bullet[1]);
      const last = blocks.at(-1);
      if (last?.type === "list") last.items.push(item);
      else blocks.push({ type: "list", items: [item] });
      continue;
    }
    // An indented line under a bullet continues that bullet.
    const last = blocks.at(-1);
    if (!paragraph.length && last?.type === "list" && /^\s{2,}\S/.test(lines[i])) {
      const item = last.items.at(-1);
      if (item.text != null) item.text += " " + line.trim();
      else item.fields.at(-1).value += " " + line.trim();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

// Splits inline markdown into [{ text, bold?, italic?, code? }] runs.
export function parseInline(text) {
  const runs = [];
  const pattern = /(\*\*([^*]+?)\*\*|`([^`]+?)`|(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w]))/g;
  let at = 0;
  for (const match of String(text ?? "").matchAll(pattern)) {
    if (match.index > at) runs.push({ text: text.slice(at, match.index) });
    if (match[2] != null) runs.push({ text: match[2], bold: true });
    else if (match[3] != null) runs.push({ text: match[3], code: true });
    else runs.push({ text: match[4], italic: true });
    at = match.index + match[0].length;
  }
  if (at < String(text ?? "").length) runs.push({ text: String(text).slice(at) });
  return runs;
}

// Tags in an agent report carry no sentiment of their own, so this is a conservative keyword heuristic:
// anything not clearly bullish or bearish stays neutral.
const BULLISH_TAG = /\b(bull\w*|upside|upgrade\w*|beat\w*|strong\w*|growth|accelerat\w*|momentum|breakout|tailwind\w*|outperform\w*|expansion|accumulat\w*|rally|uptrend|recover\w*|re-?rating|surge\w*|upturn)\b/i;
const BEARISH_TAG = /\b(bear\w*|downside|downgrade\w*|miss(es|ed)?|weak\w*|declin\w*|headwind\w*|slowdown|compression|overvalu\w*|bubble|sell-?off|downtrend|deteriorat\w*|lawsuit\w*|recession|crash|drawdown|overhang|downturn|plunge\w*|collapse\w*)\b/i;
// Chinese has no word breaks, so these match anywhere in the tag. Each side's words never contain the other side's.
const BULLISH_TAG_ZH = /看多|看涨|利好|上行|上调|上修|超预期|强劲|走强|增长|加速|突破|顺风|跑赢|扩张|吸筹|反弹|上升趋势|复苏|修复|重估|飙升|回暖|改善/;
const BEARISH_TAG_ZH = /看空|看跌|利空|下行|下调|下修|不及预期|低于预期|疲软|走弱|下滑|逆风|放缓|压缩|高估|泡沫|抛售|下跌趋势|下降趋势|恶化|诉讼|衰退|崩盘|回撤|承压|暴跌|减值/;
export function tagSentiment(tag) {
  const bull = BULLISH_TAG.test(tag) || BULLISH_TAG_ZH.test(tag),
    bear = BEARISH_TAG.test(tag) || BEARISH_TAG_ZH.test(tag);
  return bull === bear ? "neutral" : bull ? "bullish" : "bearish";
}
// "Buy"/"Overweight" read bullish, "Underweight"/"Sell" bearish, "Hold" and anything else neutral.
export function ratingSentiment(rating) {
  const r = String(rating ?? "");
  return /underweight|sell|bearish|减持|卖出|看空/i.test(r) ? "bearish" : /buy|overweight|bullish|买入|增持|看多/i.test(r) ? "bullish" : "neutral";
}
// The rating scale stays English in the data (TradingAgents and HedgeHub both parse it); a report written in Chinese
// shows it in Chinese. Anything that is not one of the five ratings is shown as written.
export const RATING_LABELS_ZH = { buy: "买入", overweight: "增持", hold: "持有", underweight: "减持", sell: "卖出" };
export function ratingLabel(rating, language = "en") {
  const text = String(rating ?? "").trim();
  return language === "zh" ? (RATING_LABELS_ZH[text.toLowerCase()] ?? text) : text;
}
// The decision rating and keyword tags pulled out of a report, for compact display.
export function reportHighlights(source) {
  const blocks = parseAgentReport(source ?? "");
  const language = textLanguage(source);
  let rating = null,
    tags = [];
  for (const block of blocks) {
    if (block.type === "facts" && !rating)
      rating = block.items.find((f) => /^(rating|评级)$/i.test(f.label))?.value ?? null;
    if (block.type === "section" && isKeywordField(block.label) && !tags.length) tags = splitKeywords(block.text);
  }
  return { rating, language, tags: tags.map((text) => ({ text, sentiment: tagSentiment(text) })) };
}

// What is happening to the company, from research the agents already wrote: each report section's summary
// gives a short rationale per stance (bullish / neutral / bearish), carried on that section's suggestions.
// Fundamentals and news describe the company itself, so they lead; sentiment only fills in when both are absent.
// Per section the two stances the agents were most confident in are kept (bullish and bearish when unrated).
const COMPANY_SECTIONS = [
  ["fundamentals_report", "Fundamentals"],
  ["news_report", "News"],
  ["sentiment_report", "Sentiment"],
];
const STANCE_ORDER = ["Bullish", "Bearish", "Neutral"];
// First sentence of a rationale, for the compact view. Figures such as "$21.4B" do not end it (no space follows
// the point), and a very short opener is kept together with the sentence after it.
// Chinese sentences end in a full-width stop with no space after it, and say as much in about half the characters.
export function leadSentence(text) {
  const source = String(text ?? "").trim(),
    match = HAN.test(source)
      ? /^(.{24,}?[。！？])(?=\s*\S)/s.exec(source)
      : /^(.{60,}?[.!?])\s+(?=["'“(]?[A-Z])/s.exec(source);
  return match ? match[1] : source;
}
export function companySummary(suggestions, symbol, limit = 4) {
  const out = [];
  for (const [section, label] of COMPANY_SECTIONS) {
    if (section === "sentiment_report" && out.length) break;
    const stances = new Map();
    for (const s of suggestions ?? []) {
      const text = String(s.rationale ?? "").trim();
      if (s.symbol !== symbol || s.sourceSection !== section || !text || stances.has(s.sentiment)) continue;
      stances.set(s.sentiment, {
        section,
        label,
        sentiment: STANCE_ORDER.includes(s.sentiment) ? s.sentiment : "Neutral",
        text,
        lead: leadSentence(text),
        confidence: Number.isFinite(s.confidence) ? s.confidence : null,
        checkedAt: s.checkedAt ?? null,
      });
    }
    const found = [...stances.values()],
      rated = found.length > 0 && found.every((f) => f.confidence != null);
    out.push(
      ...found
        .sort((a, b) =>
          rated && a.confidence !== b.confidence
            ? b.confidence - a.confidence
            : STANCE_ORDER.indexOf(a.sentiment) - STANCE_ORDER.indexOf(b.sentiment),
        )
        .slice(0, 2),
    );
  }
  return out.slice(0, limit);
}
