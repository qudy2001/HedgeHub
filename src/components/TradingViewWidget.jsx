import { useEffect, useRef } from "react";

export default function TradingViewWidget({
  type,
  config,
  title,
  className = "",
  containerClassName = "",
  bare = false,
  scriptName = ""
}) {
  const containerRef = useRef(null);
  const serializedConfig = JSON.stringify(config);
  const resolvedScriptName = scriptName || type;

  if (!type || !config) {
    return null;
  }

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return undefined;
    }

    host.innerHTML = "";

    const widgetNode = document.createElement("div");
    widgetNode.className = "tradingview-widget-container__widget";
    host.appendChild(widgetNode);

    const script = document.createElement("script");
    script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${resolvedScriptName}.js`;
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = serializedConfig;
    host.appendChild(script);

    return () => {
      host.innerHTML = "";
    };
  }, [resolvedScriptName, serializedConfig, type]);

  if (bare) {
    return (
      <div
        className={["tradingview-widget-container", containerClassName].filter(Boolean).join(" ")}
        ref={containerRef}
      />
    );
  }

  return (
    <div className={["tv-card", className].filter(Boolean).join(" ")}>
      {title ? <div className="tv-card__title">{title}</div> : null}
      <div
        className={["tradingview-widget-container", containerClassName].filter(Boolean).join(" ")}
        ref={containerRef}
      />
    </div>
  );
}
