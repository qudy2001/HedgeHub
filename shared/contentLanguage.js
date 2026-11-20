// The language AI-written content is produced in: TradingAgents research (ratings stay on the English scale, the text
// is written in the chosen language from the first prompt on) and the rule-based option read that sits next to it.
// HedgeHub's own interface stays English either way.
export const CONTENT_LANGUAGES = [
  ["en", "English"],
  ["zh", "中文"],
];
export const DEFAULT_CONTENT_LANGUAGE = "en";
export const normalizeContentLanguage = (value) =>
  CONTENT_LANGUAGES.some(([key]) => key === value) ? value : DEFAULT_CONTENT_LANGUAGE;
// The name TradingAgents knows the language by (its `output_language`).
export const agentOutputLanguage = (language) => (normalizeContentLanguage(language) === "zh" ? "Chinese" : "English");
