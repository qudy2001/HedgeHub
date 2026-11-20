import '../styles/data-pending-badge.css';

export const DATA_PENDING_MESSAGE =
  'No IV history or other analytics data yet. It will be added within 24 hours, or before the next trading day starts.';

/** "!" marker with a hover/focus tooltip for a newly added ticker. Renders nothing once data exists. */
export default function DataPendingBadge({ stock }) {
  if (stock?.ivHistory !== false) return null;
  return (
    <span
      className="data-pending-badge"
      tabIndex={0}
      role="note"
      aria-label={DATA_PENDING_MESSAGE}
      onClick={(e) => e.stopPropagation()}
    >
      !
      <span className="data-pending-tip" role="tooltip">{DATA_PENDING_MESSAGE}</span>
    </span>
  );
}
