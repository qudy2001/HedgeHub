// Turns a TradingAgents report (loose markdown: "**Label**: value" lines,
// paragraphs, bullet lists, headings, pipe tables) into blocks the UI can lay
// out. Pure text in, plain data out; nothing here produces HTML.

const FIELD = /^\*\*(.+?)\*\*\s*:\s*(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// A value this short sits in the key-facts grid; anything longer reads as prose.
export const SHORT_VALUE = 60;

const cells = (line) =>
  TABLE_ROW.exec(line)[1]
    .split("|")
    .map((cell) => cell.trim());

// "Title | Trigger: x | Entry: 1 | Notes: ..." becomes a title plus labelled parts.
export function parseListItem(text) {
  const segments = text.split(/\s+\|\s+/);
  if (segments.length < 3) return { text };
  const fields = segments.slice(1).map((segment) => {
    const match = /^([A-Za-z][A-Za-z /%-]{0,30}?)\s*:\s*(.+)$/s.exec(segment);
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
    const field = FIELD.exec(line.trim());
    if (field) {
      flush();
      const [, label, value] = field;
      if (!value) blocks.push({ type: "heading", level: 3, text: label });
      else if (value.length <= SHORT_VALUE) {
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
export function tagSentiment(tag) {
  const bull = BULLISH_TAG.test(tag),
    bear = BEARISH_TAG.test(tag);
  return bull === bear ? "neutral" : bull ? "bullish" : "bearish";
}
// "Buy"/"Overweight" read bullish, "Underweight"/"Sell" bearish, "Hold" and anything else neutral.
export function ratingSentiment(rating) {
  const r = String(rating ?? "");
  return /underweight|sell|bearish/i.test(r) ? "bearish" : /buy|overweight|bullish/i.test(r) ? "bullish" : "neutral";
}
// The decision rating and keyword tags pulled out of a report, for compact display.
export function reportHighlights(source) {
  const blocks = parseAgentReport(source ?? "");
  let rating = null,
    tags = [];
  for (const block of blocks) {
    if (block.type === "facts" && !rating)
      rating = block.items.find((f) => /^rating$/i.test(f.label))?.value ?? null;
    if (block.type === "section" && /^keywords?$/i.test(block.label))
      tags = block.text.split(/\s*,\s*/).filter(Boolean);
  }
  return { rating, tags: tags.map((text) => ({ text, sentiment: tagSentiment(text) })) };
}
