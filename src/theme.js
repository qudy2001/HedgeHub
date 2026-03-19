export const FALLBACK_THEME = "dark";
export const THEME_STORAGE_KEY = "hedgehub-theme";

export function isLightTheme(theme) {
  return theme === "light";
}

export function getInitialTheme() {
  if (typeof window === "undefined") {
    return FALLBACK_THEME;
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);

    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme;
    }
  } catch (_error) {
    // Fall through to the system preference when storage is unavailable.
  }

  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }

  return FALLBACK_THEME;
}

export function getChartPalette(theme) {
  if (isLightTheme(theme)) {
    return {
      axis: "rgba(51, 65, 85, 0.78)",
      grid: "rgba(148, 163, 184, 0.24)",
      tooltipBackground: "rgba(255, 255, 255, 0.98)",
      tooltipBorder: "rgba(148, 163, 184, 0.32)",
      strategyAreaStroke: "#0f766e",
      strategyAreaFill: "rgba(20, 184, 166, 0.18)",
      strategyLineStroke: "#d97706",
      scenarioAreaStroke: "#d97706",
      scenarioAreaFill: "rgba(245, 158, 11, 0.2)",
      scenarioLineSky: "#0369a1",
      scenarioLineEmerald: "#059669",
      historyAxis: "rgba(51, 65, 85, 0.78)",
      historyZeroGrid: "rgba(2, 132, 199, 0.4)",
      historyGrid: "rgba(148, 163, 184, 0.22)",
      historyZeroLine: "rgba(2, 132, 199, 0.34)",
      historyCandleUp: "rgba(22, 163, 74, 0.72)",
      historyCandleUpStroke: "rgba(22, 163, 74, 0.88)",
      historyCandleDown: "rgba(225, 29, 72, 0.68)",
      historyCandleDownStroke: "rgba(225, 29, 72, 0.86)"
    };
  }

  return {
    axis: "rgba(226, 232, 240, 0.65)",
    grid: "rgba(148, 163, 184, 0.12)",
    tooltipBackground: "rgba(15, 23, 42, 0.96)",
    tooltipBorder: "rgba(148, 163, 184, 0.18)",
    strategyAreaStroke: "#2dd4bf",
    strategyAreaFill: "rgba(45, 212, 191, 0.15)",
    strategyLineStroke: "#f59e0b",
    scenarioAreaStroke: "#f59e0b",
    scenarioAreaFill: "rgba(245, 158, 11, 0.22)",
    scenarioLineSky: "#38bdf8",
    scenarioLineEmerald: "#34d399",
    historyAxis: "rgba(209, 212, 220, 0.68)",
    historyZeroGrid: "rgba(56, 189, 248, 0.36)",
    historyGrid: "rgba(148, 163, 184, 0.12)",
    historyZeroLine: "rgba(56, 189, 248, 0.28)",
    historyCandleUp: "rgba(52, 211, 153, 0.78)",
    historyCandleUpStroke: "rgba(52, 211, 153, 0.94)",
    historyCandleDown: "rgba(251, 113, 133, 0.72)",
    historyCandleDownStroke: "rgba(251, 113, 133, 0.92)"
  };
}

export function getScenarioHeatmapCellStyle(value, maxAbsValue, theme) {
  if (!Number.isFinite(value)) {
    return isLightTheme(theme)
      ? {
          background: "rgba(255, 255, 255, 0.88)",
          borderColor: "rgba(148, 163, 184, 0.2)",
          color: "#475569"
        }
      : {
          background: "rgba(15, 23, 42, 0.54)",
          borderColor: "rgba(148, 163, 184, 0.12)",
          color: "#94a3b8"
        };
  }

  const intensity = maxAbsValue > 0 ? Math.min(Math.abs(value) / maxAbsValue, 1) : 0;
  const nearFlat = Math.abs(value) < Math.max(maxAbsValue * 0.08, 25);

  if (nearFlat && value >= 0) {
    return isLightTheme(theme)
      ? {
          background: "#dcfce7",
          borderColor: "#86efac",
          color: "#166534"
        }
      : {
          background: "#a7f3d0",
          borderColor: "#6ee7b7",
          color: "#052e16"
        };
  }

  if (nearFlat) {
    return {
      background: "#facc15",
      borderColor: "#fcd34d",
      color: "#1f2937"
    };
  }

  if (value >= 0) {
    if (intensity >= 0.55) {
      return {
        background: "#22c55e",
        borderColor: "#4ade80",
        color: "#052e16"
      };
    }

    return {
      background: "#86efac",
      borderColor: "#bbf7d0",
      color: "#14532d"
    };
  }

  if (intensity >= 0.55) {
    return {
      background: "#ef4444",
      borderColor: "#f87171",
      color: "#450a0a"
    };
  }

  return {
    background: "#fb923c",
    borderColor: "#fdba74",
    color: "#431407"
  };
}

export function getMacroTileColors(changePct, theme) {
  const intensity = Math.min(Math.abs(changePct ?? 0), 8) / 8;

  if (isLightTheme(theme)) {
    if ((changePct ?? 0) >= 0) {
      return {
        background:
          `radial-gradient(circle at top left, rgba(22, 163, 74, ${0.12 + intensity * 0.18}), transparent 64%), ` +
          "linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(240, 253, 244, 0.96))",
        stroke: `rgba(22, 163, 74, ${0.2 + intensity * 0.24})`,
        text: "#14532d",
        line: "#16a34a",
        baseline: "rgba(22, 163, 74, 0.18)"
      };
    }

    return {
      background:
        `radial-gradient(circle at top left, rgba(225, 29, 72, ${0.12 + intensity * 0.2}), transparent 64%), ` +
        "linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 241, 242, 0.96))",
      stroke: `rgba(225, 29, 72, ${0.2 + intensity * 0.24})`,
      text: "#881337",
      line: "#e11d48",
      baseline: "rgba(225, 29, 72, 0.18)"
    };
  }

  if ((changePct ?? 0) >= 0) {
    return {
      background:
        `radial-gradient(circle at top left, rgba(52, 211, 153, ${0.14 + intensity * 0.2}), transparent 64%), ` +
        "linear-gradient(180deg, rgba(17, 24, 39, 0.92), rgba(2, 6, 23, 0.98))",
      stroke: `rgba(167, 243, 208, ${0.24 + intensity * 0.26})`,
      text: "#ecfdf5",
      line: "#6ee7b7",
      baseline: "rgba(167, 243, 208, 0.34)"
    };
  }

  return {
    background:
      `radial-gradient(circle at top left, rgba(251, 113, 133, ${0.14 + intensity * 0.22}), transparent 64%), ` +
      "linear-gradient(180deg, rgba(17, 24, 39, 0.92), rgba(2, 6, 23, 0.98))",
    stroke: `rgba(253, 164, 175, ${0.24 + intensity * 0.28})`,
    text: "#fff1f2",
    line: "#fb7185",
    baseline: "rgba(253, 164, 175, 0.34)"
  };
}
