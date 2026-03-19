import { useEffect, useMemo, useRef } from "react";

export default function TradingViewWidget({
  type,
  config,
  title,
  className = "",
  containerClassName = "",
  bare = false,
  scriptName = "",
  theme = "dark"
}) {
  const containerRef = useRef(null);
  const resolvedScriptName = scriptName || type;
  const themedConfig = useMemo(() => {
    if (!config) {
      return null;
    }

    const nextConfig = { ...config };
    const resolvedTheme = theme === "light" ? "light" : "dark";

    if ("colorTheme" in nextConfig || type !== "advanced-chart") {
      nextConfig.colorTheme = resolvedTheme;
    }

    if ("theme" in nextConfig || type === "advanced-chart") {
      nextConfig.theme = resolvedTheme;
    }

    if (resolvedTheme === "light") {
      if ("backgroundColor" in nextConfig) {
        nextConfig.backgroundColor = "rgba(255, 255, 255, 0)";
      }

      if ("gridColor" in nextConfig) {
        nextConfig.gridColor = "rgba(148, 163, 184, 0.18)";
      }

      if ("scaleFontColor" in nextConfig) {
        nextConfig.scaleFontColor = "rgba(51, 65, 85, 0.78)";
      }

      if ("symbolActiveColor" in nextConfig) {
        nextConfig.symbolActiveColor = "rgba(2, 132, 199, 0.12)";
      }
    }

    return nextConfig;
  }, [config, theme, type]);
  const serializedConfig = useMemo(() => JSON.stringify(themedConfig), [themedConfig]);

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
  }, [resolvedScriptName, serializedConfig]);

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
