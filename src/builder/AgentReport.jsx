import { useState } from "react";
import { parseAgentReport, parseInline, ratingSentiment, tagSentiment } from "../../shared/agentReport.js";

const STEP_VALUE = 24;

function Inline({ text }) {
  return parseInline(text).map((run, i) =>
    run.bold ? (
      <strong key={i}>{run.text}</strong>
    ) : run.italic ? (
      <em key={i}>{run.text}</em>
    ) : run.code ? (
      <code key={i}>{run.text}</code>
    ) : (
      run.text
    ),
  );
}

function ListItem({ item }) {
  if (item.text != null)
    return (
      <li>
        <Inline text={item.text} />
      </li>
    );
  // Inside a step only figures go in the grid; a trigger or note reads better as a sentence.
  const short = item.fields.filter((f) => f.label && f.value.length <= STEP_VALUE);
  const long = item.fields.filter((f) => !short.includes(f));
  return (
    <li className="agent-report-step">
      <strong>
        <Inline text={item.title} />
      </strong>
      {short.length > 0 && (
        <dl className="agent-report-facts">
          {short.map((f, i) => (
            <div key={i}>
              <dt>{f.label}</dt>
              <dd>
                <Inline text={f.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {long.map((f, i) => (
        <p key={i}>
          {f.label && <span className="agent-report-label">{f.label}: </span>}
          <Inline text={f.value} />
        </p>
      ))}
    </li>
  );
}

// The agents' short read of what is happening to the company (see companySummary), under the valuation.
export function CompanySummary({ items }) {
  const [full, setFull] = useState(false);
  if (!items.length) return null;
  const more = items.some((i) => i.lead !== i.text),
    sources = [...new Set(items.map((i) => i.label.toLowerCase()))],
    checked = items.map((i) => i.checkedAt).filter(Boolean).sort().at(-1);
  return (
    <section className="company-summary">
      <h4>What's happening</h4>
      <ul>
        {items.map((item) => (
          <li key={`${item.section}:${item.sentiment}`} className={item.sentiment.toLowerCase()}>
            <strong>
              {item.label} · {item.sentiment}
            </strong>{" "}
            {full ? item.text : item.lead}
          </li>
        ))}
      </ul>
      <small className="subtle">
        From the agents' {sources.join(" and ")} report{sources.length === 1 ? "" : "s"}
        {checked ? ` · ${String(checked).slice(0, 10)}` : ""}. Their read, not verified facts.
        {more && (
          <>
            {" "}
            <button className="text-button" aria-expanded={full} onClick={() => setFull(!full)}>
              {full ? "Show less" : "Show more"}
            </button>
          </>
        )}
      </small>
    </section>
  );
}

// Formatted view of a TradingAgents report. Builds React elements only, so report text is never injected as HTML.
// Compact rating + keyword chips (used in the Agent valuation panel).
export function AgentHighlights({ rating, tags }) {
  return (
    <div className="agent-highlights">
      {rating && (
        <div className="agent-rating">
          <span>Rating</span>
          <strong className={ratingSentiment(rating)}>{rating}</strong>
        </div>
      )}
      {tags.length > 0 && (
        <>
          <h4>Keywords</h4>
          <ul className="agent-report-tags">
            {tags.map((t, i) => (
              <li key={i} className={t.sentiment}>
                {t.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function AgentReport({ text, className = "" }) {
  const blocks = parseAgentReport(text);
  if (!blocks.length)
    return <p className="subtle">No report available.</p>;
  return (
    <div className={`agent-report ${className}`.trim()}>
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          const Tag = block.level <= 2 ? "h3" : "h4";
          return (
            <Tag key={i}>
              <Inline text={block.text} />
            </Tag>
          );
        }
        if (block.type === "facts")
          return (
            <dl className="agent-report-facts" key={i}>
              {block.items.map((f, j) => (
                <div key={j}>
                  <dt>{f.label}</dt>
                  <dd>
                    <Inline text={f.value} />
                  </dd>
                </div>
              ))}
            </dl>
          );
        if (block.type === "section")
          return (
            <section key={i}>
              <h4>{block.label}</h4>
              {/^keywords?$/i.test(block.label) ? (
                <ul className="agent-report-tags">
                  {block.text.split(/\s*,\s*/).map((tag, j) => (
                    <li key={j} className={tagSentiment(tag)}>
                      {tag}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  <Inline text={block.text} />
                </p>
              )}
            </section>
          );
        if (block.type === "list")
          return (
            <ul
              key={i}
              className={
                block.items.some((item) => item.fields)
                  ? "agent-report-steps"
                  : undefined
              }
            >
              {block.items.map((item, j) => (
                <ListItem item={item} key={j} />
              ))}
            </ul>
          );
        if (block.type === "table")
          return (
            <div className="agent-report-table" key={i}>
              <table>
                <thead>
                  <tr>
                    {block.head.map((cell, j) => (
                      <th key={j}>
                        <Inline text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((cell, k) => (
                        <td key={k}>
                          <Inline text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return (
          <p key={i}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
