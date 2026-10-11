const DAY = 86400_000;
const TOPICS = [
  ['earnings / guidance', /\b(earnings|guidance|revenue|margin|eps)\b/i],
  ['sales / deliveries', /\b(sales|deliveries|delivery|registrations|production)\b/i],
  ['products / launches', /\b(product|launch|robotaxi|autonomy|fsd|release)\b/i],
  ['regulation / litigation', /\b(regulator|regulation|lawsuit|recall|tariff|approval|court)\b/i],
  ['macro / rates', /\b(inflation|cpi|payroll|fomc|interest rate|federal reserve)\b/i],
  ['valuation / positioning', /\b(valuation|overvalued|undervalued|short squeeze|options|puts|calls)\b/i]
];
export function summarizeSocial(posts, now = new Date().toISOString()) {
  const unique = [...new Map(posts.filter(p => p.date && Date.parse(p.date) <= Date.parse(now)).map(p => [p.source + ':' + p.id, p])).values()];
  const recent = unique.filter(p => Date.parse(p.date) >= Date.parse(now) - 7 * DAY);
  const topics = TOPICS.map(([label, pattern]) => ({ label, mentions: recent.filter(p => pattern.test(p.text)).length })).filter(t => t.mentions).sort((a, b) => b.mentions - a.mentions);
  // Deliberately do not turn a word lexicon into a sentiment score. Sarcasm,
  // negation, ticker ambiguity and coordinated posting need a validated model.
  return { sampleCount: unique.length, last7DaysCount: recent.length, topics, sentiment: null,
    sentimentStatus: 'Not scored: review the linked discussion; no validated sentiment model is configured.',
    posts: unique.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map(({ text, ...p }) => ({ ...p, excerpt: text.slice(0, 240) })),
    method: 'Keyword topic counts from a capped English-language sample; overlapping topics, not trend estimates or market-wide sentiment.' };
}
async function json(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Social provider HTTP ${response.status}`);
  return response.json();
}
export async function fetchResearchSocial(symbol, window) {
  if (process.env.RESEARCH_SOCIAL_ENABLED !== 'true') throw new Error('Social collection is disabled; configure approved X/Reddit API access');
  const now = new Date().toISOString(), posts = [], sources = [];
  if (process.env.X_BEARER_TOKEN) {
    try {
      const archive = process.env.X_RESEARCH_ARCHIVE === 'true';
      const from = archive ? `${window.from}T00:00:00.000Z` : new Date(Date.now() - 7 * DAY + 60_000).toISOString();
      const q = new URLSearchParams({ query: `$${symbol} lang:en -is:retweet`, start_time: from, max_results: '100', 'tweet.fields': 'created_at' });
      const data = await json(`https://api.x.com/2/tweets/search/${archive ? 'all' : 'recent'}?${q}`, { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` });
      if (data.errors?.length) throw new Error('X returned partial errors; coverage not verified');
      for (const p of data.data ?? []) posts.push({ id: p.id, source: 'X', text: p.text, date: p.created_at, url: `https://x.com/i/status/${p.id}` });
      sources.push({ name: 'X', from, to: now, sampled: true, truncated: Boolean(data.meta?.next_token), note: 'Up to 100 matching posts; cashtag-only query.' });
    } catch (e) { sources.push({ name: 'X', error: e.message }); }
  } else sources.push({ name: 'X', error: 'API token not configured' });
  if (process.env.REDDIT_ACCESS_TOKEN && process.env.REDDIT_USER_AGENT) {
    try {
      const q = new URLSearchParams({ q: `$${symbol}`, sort: 'new', t: window.lookbackDays > 30 ? 'year' : 'month', limit: '100', raw_json: '1' });
      const data = await json(`https://oauth.reddit.com/search?${q}`, { authorization: `Bearer ${process.env.REDDIT_ACCESS_TOKEN}`, 'user-agent': process.env.REDDIT_USER_AGENT });
      if (!Array.isArray(data.data?.children)) throw new Error('Reddit returned an invalid listing');
      for (const { data: p } of data.data.children) {
        const date = new Date(p.created_utc * 1000).toISOString();
        if (date.slice(0, 10) >= window.from && /^\/r\//.test(p.permalink)) posts.push({ id: p.id, source: 'Reddit', text: `${p.title ?? ''} ${p.selftext ?? ''}`, date, url: `https://www.reddit.com${p.permalink}` });
      }
      sources.push({ name: 'Reddit', from: window.from, to: now, sampled: true, truncated: Boolean(data.data.after), note: 'Up to 100 search submissions; comments excluded and ticker matches need review.' });
    } catch (e) { sources.push({ name: 'Reddit', error: e.message }); }
  } else sources.push({ name: 'Reddit', error: 'OAuth token / identifying user agent not configured' });
  if (sources.every(s => s.error)) throw new Error(sources.map(s => `${s.name}: ${s.error}`).join('; '));
  return { ...summarizeSocial(posts, now), sources, capturedAt: now, complete: false };
}
