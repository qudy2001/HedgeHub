import { useCallback, useEffect, useMemo, useState } from "react";
import "../styles/ai-schedule-templates.css";
import {
  AI_SCHEDULE_TEMPLATES,
  TEMPLATE_GROUPS,
  defaultTemplateValues,
  getTemplate,
  renderTemplate,
  scheduleHint,
  templateVariables
} from "../../shared/aiScheduleTemplates.js";

const STORAGE_KEY = "hedgehub.aiTemplates";

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      selected: typeof saved?.selected === "string" ? saved.selected : "",
      values: saved?.values && typeof saved.values === "object" ? saved.values : {}
    };
  } catch {
    return { selected: "", values: {} };
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // navigator.clipboard only exists in secure contexts; fall back for http://<lan-host>:port.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.body.removeChild(area);
    }
  }
}

function Field({ idPrefix, variable, value, error, onChange, onBlur }) {
  const id = `${idPrefix}-${variable.key}`;
  const help = variable.help ? (
    <small className="ai-templates__help" id={`${id}-help`}>
      {variable.help}
    </small>
  ) : null;
  const unfilled = typeof value === "string" ? !value.trim() : Array.isArray(value) && value.length === 0;
  const problem = error ? (
    <small className={`ai-templates__error${unfilled ? " ai-templates__error--unfilled" : ""}`} role={unfilled ? undefined : "alert"}>
      {unfilled && variable.type !== "multi" ? "Needed to build the prompt" : error}
    </small>
  ) : null;
  const described = [variable.help ? `${id}-help` : null].filter(Boolean).join(" ") || undefined;

  if (variable.type === "boolean") {
    return (
      <div className="ai-templates__field ai-templates__field--wide">
        <label className="ai-templates__check">
          <input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} aria-describedby={described} />
          <span>{variable.label}</span>
        </label>
        {help}
      </div>
    );
  }

  if (variable.type === "multi") {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="ai-templates__field ai-templates__field--wide ai-templates__multi">
        <legend>{variable.label}</legend>
        <div className="ai-templates__checks">
          {variable.options.map(([key, label]) => (
            <label key={key} className="ai-templates__check">
              <input
                type="checkbox"
                checked={chosen.includes(key)}
                onChange={(event) => onChange(event.target.checked ? [...chosen, key] : chosen.filter((item) => item !== key))}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {problem}
      </fieldset>
    );
  }

  let control;
  if (variable.type === "select") {
    control = (
      <select
        id={id}
        value={variable.options.some(([key]) => key === value) ? value : variable.default}
        onChange={(event) => onChange(event.target.value)}
      >
        {variable.options.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    );
  } else if (variable.type === "textarea") {
    control = (
      <textarea
        id={id}
        rows={variable.key === "extra" ? 3 : 4}
        value={value}
        placeholder={variable.placeholder}
        maxLength={variable.maxLength}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={described}
        aria-invalid={error ? true : undefined}
      />
    );
  } else if (variable.type === "number") {
    control = (
      <input
        id={id}
        type="number"
        min={variable.min}
        max={variable.max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-describedby={described}
        aria-invalid={error ? true : undefined}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type="text"
        value={value}
        maxLength={variable.type === "text" ? variable.maxLength : 200}
        autoCapitalize={variable.type === "tickers" ? "characters" : undefined}
        spellCheck={variable.type === "tickers" ? false : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-describedby={described}
        aria-invalid={error ? true : undefined}
      />
    );
  }

  return (
    <div className={`ai-templates__field${variable.type === "textarea" ? " ai-templates__field--wide" : ""}`}>
      <label htmlFor={id}>{variable.label}</label>
      {control}
      {help}
      {problem}
    </div>
  );
}

export default function AiScheduleTemplates({ onUseAsTask = null } = {}) {
  const [saved] = useState(loadSaved);
  const [selectedId, setSelectedId] = useState(() => (getTemplate(saved.selected) ? saved.selected : AI_SCHEDULE_TEMPLATES[0].id));
  const [valuesById, setValuesById] = useState(saved.values);
  const [status, setStatus] = useState(null);
  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const template = getTemplate(selectedId) ?? AI_SCHEDULE_TEMPLATES[0];
  const variables = useMemo(() => templateVariables(template), [template]);
  const raw = useMemo(() => ({ ...defaultTemplateValues(template), ...(valuesById[template.id] ?? {}) }), [template, valuesById]);
  const result = useMemo(() => renderTemplate(template, raw), [template, raw]);
  const hint = useMemo(() => scheduleHint(template, result.values, { timeZone }), [template, result.values, timeZone]);
  const mainVariables = variables.filter((variable) => !variable.advanced);
  const advancedVariables = variables.filter((variable) => variable.advanced);
  const customised = Boolean(valuesById[template.id] && Object.keys(valuesById[template.id]).length);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ selected: selectedId, values: valuesById }));
    } catch {
      /* storage unavailable (private window); the choices just are not remembered */
    }
  }, [selectedId, valuesById]);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(timer);
  }, [status]);

  const setValue = useCallback(
    (key, value) => {
      setValuesById((current) => ({ ...current, [template.id]: { ...(current[template.id] ?? {}), [key]: value } }));
    },
    [template.id]
  );

  const selectTemplate = useCallback((id) => {
    setSelectedId(id);
    setStatus(null);
  }, []);

  const resetFields = useCallback(() => {
    setValuesById((current) => {
      const next = { ...current };
      delete next[template.id];
      return next;
    });
    setStatus(null);
  }, [template.id]);

  const handleCopy = useCallback(async () => {
    if (!result.ok) return;
    const copied = await copyText(result.text);
    setStatus(
      copied
        ? { tone: "success", message: `Copied ${result.text.length.toLocaleString("en-GB")} characters. Paste them into your scheduled task.` }
        : { tone: "error", message: "Could not copy automatically. Click inside the prompt box, select all and copy." }
    );
  }, [result]);

  const handleQueue = useCallback(() => {
    const task = renderTemplate(template, raw, { mode: "task" });
    if (!task.ok || !onUseAsTask) return;
    onUseAsTask({ prompt: task.text, cadence: template.taskCadence ?? "" });
    setStatus({ tone: "info", message: "Added to the Add task definition form above. Review it and press Create." });
  }, [onUseAsTask, raw, template]);

  const queueDisabledReason = !template.queueable
    ? template.queueRunner
      ? "This one runs on your AI platform's schedule: it is what works through the queue."
      : "This one needs the AI platform's own clock, so it cannot be queued."
    : null;

  return (
    <article className="insight-card admin-users__panel ai-templates">
      <header className="ai-templates__header">
        <h3>AI schedule templates</h3>
        <p className="ai-templates__lede">
          Prompts to paste into a scheduled task in Claude or ChatGPT. The platform&apos;s clock triggers the run, and the HedgeHub connector lets the AI read and
          write your AI topics. Pick one, edit the fields, copy.
        </p>
      </header>

      <details className="ai-templates__howto">
        <summary>How to set one up</summary>
        <ol>
          <li>
            <strong>Connect HedgeHub once.</strong> Claude: Settings, Connectors, add a custom connector. ChatGPT: Settings, Connectors, Advanced, Developer mode.
            The steps and the URL format are in <code>mcp-server/README.md</code>. The URL contains your access token, so treat it like a password; the templates
            never include it.
          </li>
          <li>
            <strong>Copy a prompt</strong> below and create a scheduled task: Claude, Cowork, Scheduled (or type <code>/schedule</code>); ChatGPT, Tasks. Use the
            schedule suggested for the template.
          </li>
          <li>
            <strong>Run it once by hand</strong> and approve the HedgeHub tools if asked. Then check the topics under Builder, AI suggestions. If the run says
            &quot;HedgeHub connector unavailable&quot;, the scheduled run cannot see the connector: check that it is enabled for the task, or try the other platform.
          </li>
          <li>
            <strong>Or let HedgeHub keep the schedule.</strong> Schedule only <em>Task queue runner</em> on the platform, then use <em>Queue in HedgeHub</em> on the
            other templates. HedgeHub creates the tasks hourly, daily, weekly or monthly and the runner works through them. This also saves task slots: ChatGPT caps active tasks by plan
            (roughly 3 to 15) and will not repeat a task more than once an hour.
          </li>
        </ol>
      </details>

      <div className="ai-templates__layout">
        <nav className="ai-templates__list" aria-label="Templates">
          {TEMPLATE_GROUPS.map((group) => {
            const items = AI_SCHEDULE_TEMPLATES.filter((item) => item.group === group.id);
            if (!items.length) return null;
            return (
              <section key={group.id} className="ai-templates__group">
                <h4 title={group.blurb}>{group.label}</h4>
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="ai-templates__item"
                    aria-pressed={item.id === template.id}
                    onClick={() => selectTemplate(item.id)}
                  >
                    {item.title}
                  </button>
                ))}
              </section>
            );
          })}
        </nav>

        <div className="ai-templates__detail">
          <header>
            <h4>{template.title}</h4>
            <p className="ai-templates__summary">{template.summary}</p>
            <div className="ai-templates__chips">
              {hint ? <span className="ai-templates__chip ai-templates__chip--time">{hint.text}</span> : null}
              <span className="ai-templates__chip">{template.needsWeb ? "Needs web search" : "Mostly HedgeHub data"}</span>
              {template.queueable ? <span className="ai-templates__chip">Can be queued in HedgeHub ({template.taskCadence})</span> : null}
            </div>
            <p className="ai-templates__zone">
              Times are in your time zone ({timeZone}).
              {hint?.cron ? (
                <>
                  {" "}
                  Cron for Claude Code or desktop schedulers: <code>{hint.cron}</code>
                </>
              ) : null}
            </p>
          </header>

          <form className="admin-users__form ai-templates__form" onSubmit={(event) => event.preventDefault()}>
            <div className="ai-templates__fields">
              {mainVariables.map((variable) => (
                <Field
                  key={`${template.id}-${variable.key}`}
                  idPrefix={`ai-template-${template.id}`}
                  variable={variable}
                  value={raw[variable.key]}
                  error={result.errors[variable.key]}
                  onChange={(value) => setValue(variable.key, value)}
                  onBlur={() => {
                    const clean = result.values[variable.key];
                    if (clean === undefined) return;
                    setValue(variable.key, variable.type === "tickers" ? clean.join(", ") : clean);
                  }}
                />
              ))}
            </div>

            <details className="ai-templates__options">
              <summary>Options</summary>
              <div className="ai-templates__fields">
                {advancedVariables.map((variable) => (
                  <Field
                    key={`${template.id}-${variable.key}`}
                    idPrefix={`ai-template-${template.id}`}
                    variable={variable}
                    value={raw[variable.key]}
                    error={result.errors[variable.key]}
                    onChange={(value) => setValue(variable.key, value)}
                    onBlur={() => {}}
                  />
                ))}
              </div>
            </details>
          </form>

          <div className="ai-templates__prompt">
            <div className="ai-templates__prompt-head">
              <label htmlFor="ai-template-preview">Prompt to paste</label>
              <span className="timestamp">{result.ok ? `${result.text.length.toLocaleString("en-GB")} characters` : "Fix the highlighted fields"}</span>
            </div>
            <textarea
              id="ai-template-preview"
              className="ai-templates__preview"
              readOnly
              rows={16}
              value={result.ok ? result.text : "Fill in the highlighted fields above to see the prompt."}
              onFocus={(event) => event.target.select()}
            />
          </div>

          <div className="admin-users__actions">
            <button type="button" className="macro-layout-button macro-layout-button--primary" onClick={() => void handleCopy()} disabled={!result.ok}>
              Copy prompt
            </button>
            {onUseAsTask && !template.queueRunner ? (
              <button
                type="button"
                className="macro-layout-button"
                onClick={handleQueue}
                disabled={!result.ok || !template.queueable}
                title={queueDisabledReason ?? "Fills the Add task definition form above with this template and its suggested cadence."}
              >
                Queue in HedgeHub
              </button>
            ) : null}
            <button type="button" className="macro-layout-button" onClick={resetFields} disabled={!customised}>
              Reset fields
            </button>
          </div>
          {status ? (
            <div className={`refresh-feedback refresh-feedback--${status.tone}`} role="status">
              {status.message}
            </div>
          ) : null}
          {!template.queueable && !template.queueRunner && onUseAsTask ? <p className="ai-templates__note">{queueDisabledReason}</p> : null}

          {template.tips?.length ? (
            <ul className="ai-templates__tips">
              {template.tips.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </article>
  );
}
