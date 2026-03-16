const macroHeatmapCatalog = [
  {
    id: "global-markets",
    title: "Global Risk Markets",
    description:
      "Tradable market-cap and outstanding-value map across listed equities, bonds, FX reserve proxies, crypto, and commodity stock values.",
    note:
      "Forex and commodity tiles use reserve or stock-value proxies in USD because those markets do not have a clean market cap.",
    groups: [
      {
        id: "stocks",
        title: "Stocks",
        description: "Divided by market and listing region.",
        tiles: [
          { id: "stocks-us", label: "US Equities", valueUsd: 63e12, changePct: 1.8, detail: "NYSE + Nasdaq listed market cap." },
          { id: "stocks-europe", label: "Europe Equities", valueUsd: 15e12, changePct: 0.9, detail: "Eurozone, Nordic, and Swiss listed cap." },
          { id: "stocks-china", label: "China Equities", valueUsd: 12e12, changePct: -1.4, detail: "A-shares, H-shares, and ADR mix." },
          { id: "stocks-japan", label: "Japan Equities", valueUsd: 6.8e12, changePct: 1.6, detail: "Tokyo listed market cap." },
          { id: "stocks-india", label: "India Equities", valueUsd: 5.5e12, changePct: 2.7, detail: "NSE and BSE listed market cap." },
          { id: "stocks-uk", label: "UK Equities", valueUsd: 3.3e12, changePct: 0.7, detail: "LSE listed market cap." },
          { id: "stocks-latam-mea", label: "LatAm / MEA Equities", valueUsd: 4.8e12, changePct: 1.2, detail: "Brazil, Gulf, South Africa, and regional listings." },
          { id: "stocks-asia-ex", label: "Asia ex-Japan / China", valueUsd: 6.4e12, changePct: 1.0, detail: "Korea, Taiwan, ASEAN, Australia, and Hong Kong ex-China view." }
        ]
      },
      {
        id: "bonds",
        title: "Bond Markets",
        description: "Divided by country and credit sector.",
        tiles: [
          { id: "bonds-us-treasuries", label: "US Treasuries", valueUsd: 27.8e12, changePct: -0.6, detail: "Marketable Treasury debt outstanding." },
          { id: "bonds-us-credit", label: "US Corporate Credit", valueUsd: 14.1e12, changePct: 0.4, detail: "Investment-grade, high-yield, and loan market proxy." },
          { id: "bonds-euro-sovereigns", label: "Euro Sovereigns", valueUsd: 13.6e12, changePct: 0.2, detail: "Euro-area government bond stack." },
          { id: "bonds-euro-credit", label: "Euro Corporate Credit", valueUsd: 5.2e12, changePct: 0.3, detail: "Euro investment-grade and high-yield credit." },
          { id: "bonds-japan", label: "Japan Govies", valueUsd: 8.7e12, changePct: -0.2, detail: "Japanese government bond market." },
          { id: "bonds-china", label: "China Gov / Policy Banks", valueUsd: 7.9e12, changePct: 0.5, detail: "Chinese sovereign and policy-bank debt." },
          { id: "bonds-em", label: "EM Sovereign & Local", valueUsd: 6.1e12, changePct: 0.7, detail: "Emerging-market sovereign and local-currency debt." },
          { id: "bonds-structured", label: "Structured Credit", valueUsd: 4.3e12, changePct: 0.1, detail: "Agency MBS, ABS, and securitized credit proxy." }
        ]
      },
      {
        id: "forex",
        title: "Forex",
        description: "Divided by currency using reserve-money and settlement-float proxies.",
        tiles: [
          { id: "fx-usd", label: "USD", valueUsd: 6.9e12, changePct: 0.5, detail: "Global reserve and settlement stock proxy." },
          { id: "fx-eur", label: "EUR", valueUsd: 2.4e12, changePct: 0.2, detail: "Reserve and settlement stock proxy." },
          { id: "fx-jpy", label: "JPY", valueUsd: 1.3e12, changePct: -0.4, detail: "Reserve and settlement stock proxy." },
          { id: "fx-gbp", label: "GBP", valueUsd: 0.8e12, changePct: 0.1, detail: "Reserve and settlement stock proxy." },
          { id: "fx-cny", label: "CNY", valueUsd: 0.9e12, changePct: 0.7, detail: "Reserve and settlement stock proxy." },
          { id: "fx-chf", label: "CHF", valueUsd: 0.5e12, changePct: -0.1, detail: "Reserve and settlement stock proxy." },
          { id: "fx-em-basket", label: "EM Currency Basket", valueUsd: 1.1e12, changePct: 0.4, detail: "Other reserve and funding currencies combined." }
        ]
      },
      {
        id: "crypto",
        title: "Crypto",
        description: "Divided by coin and stablecoin complex.",
        tiles: [
          { id: "crypto-btc", label: "Bitcoin", valueUsd: 1.74e12, changePct: 4.8, detail: "BTC market cap." },
          { id: "crypto-eth", label: "Ethereum", valueUsd: 0.44e12, changePct: 3.4, detail: "ETH market cap." },
          { id: "crypto-stables", label: "Stablecoins", valueUsd: 0.19e12, changePct: 1.1, detail: "USDT, USDC, DAI, and peers combined." },
          { id: "crypto-sol", label: "Solana", valueUsd: 0.09e12, changePct: 5.6, detail: "SOL market cap." },
          { id: "crypto-bnb", label: "BNB", valueUsd: 0.08e12, changePct: 1.8, detail: "BNB market cap." },
          { id: "crypto-xrp", label: "XRP", valueUsd: 0.1e12, changePct: 2.5, detail: "XRP market cap." },
          { id: "crypto-other", label: "Other Crypto", valueUsd: 0.48e12, changePct: -1.3, detail: "Other large-cap and long-tail crypto assets." }
        ]
      },
      {
        id: "commodities",
        title: "Commodities",
        description: "Divided by type, with exchange and sub-category proxies merged.",
        tiles: [
          { id: "commodities-gold", label: "Gold", valueUsd: 15.7e12, changePct: 1.2, detail: "Above-ground gold stock value." },
          { id: "commodities-silver", label: "Silver", valueUsd: 1.8e12, changePct: 0.9, detail: "Above-ground silver stock value." },
          { id: "commodities-petroleum", label: "Petroleum Complex", valueUsd: 4.1e12, changePct: -1.1, detail: "USOIL, UKOIL, refined products, and related petroleum commodities combined." },
          { id: "commodities-gas", label: "Natural Gas", valueUsd: 0.7e12, changePct: -0.8, detail: "Global gas storage and listed proxy value." },
          { id: "commodities-copper", label: "Copper", valueUsd: 0.33e12, changePct: 1.4, detail: "Visible inventory and production-value proxy." },
          { id: "commodities-agri", label: "Agriculture Complex", valueUsd: 2.2e12, changePct: 0.6, detail: "Grains, softs, and livestock combined." },
          { id: "commodities-industrial", label: "Industrial Metals Basket", valueUsd: 0.95e12, changePct: 0.8, detail: "Aluminium, nickel, zinc, and peers combined." }
        ]
      }
    ]
  },
  {
    id: "etf-heatmap",
    title: "ETF Heatmap",
    description:
      "ETF assets grouped by asset class so the dashboard can show where listed wrapper demand is sitting and how that AUM is moving.",
    note:
      "ETF tiles use AUM in USD as the size metric, with value change shown as the color signal.",
    groups: [
      {
        id: "etf-equity",
        title: "Equity ETFs",
        description: "Broad-market, style, and regional equity ETFs.",
        tiles: [
          { id: "etf-spy", label: "SPY", valueUsd: 610e9, changePct: -0.57, detail: "SPDR S&P 500 ETF." },
          { id: "etf-voo", label: "VOO", valueUsd: 580e9, changePct: -0.56, detail: "Vanguard S&P 500 ETF." },
          { id: "etf-ivv", label: "IVV", valueUsd: 520e9, changePct: -0.56, detail: "iShares S&P 500 ETF." },
          { id: "etf-vti", label: "VTI", valueUsd: 480e9, changePct: -0.55, detail: "Vanguard Total Stock Market ETF." },
          { id: "etf-qqq", label: "QQQ", valueUsd: 330e9, changePct: -0.59, detail: "Invesco Nasdaq 100 ETF." },
          { id: "etf-vug", label: "VUG", valueUsd: 160e9, changePct: -1.12, detail: "Vanguard Growth ETF." },
          { id: "etf-vea", label: "VEA", valueUsd: 125e9, changePct: -1.16, detail: "Vanguard Developed Markets ETF." },
          { id: "etf-vxus", label: "VXUS", valueUsd: 95e9, changePct: -0.94, detail: "Vanguard Total International Stock ETF." },
          { id: "etf-vwo", label: "VWO", valueUsd: 85e9, changePct: -0.53, detail: "Vanguard Emerging Markets ETF." },
          { id: "etf-iwm", label: "IWM", valueUsd: 70e9, changePct: -0.33, detail: "iShares Russell 2000 ETF." }
        ]
      },
      {
        id: "etf-fixed-income",
        title: "Fixed Income ETFs",
        description: "Sovereign, aggregate, and credit ETF wrappers.",
        tiles: [
          { id: "etf-bnd", label: "BND", valueUsd: 120e9, changePct: -0.10, detail: "Vanguard Total Bond Market ETF." },
          { id: "etf-agg", label: "AGG", valueUsd: 102e9, changePct: -0.08, detail: "iShares Core US Aggregate Bond ETF." },
          { id: "etf-sgov", label: "SGOV", valueUsd: 37e9, changePct: 0.03, detail: "iShares 0-3 Month Treasury Bond ETF." },
          { id: "etf-bil", label: "BIL", valueUsd: 36e9, changePct: 0.03, detail: "SPDR 1-3 Month T-Bill ETF." },
          { id: "etf-ief", label: "IEF", valueUsd: 32e9, changePct: -0.10, detail: "iShares 7-10 Year Treasury Bond ETF." },
          { id: "etf-tlt", label: "TLT", valueUsd: 48e9, changePct: -0.49, detail: "iShares 20+ Year Treasury Bond ETF." },
          { id: "etf-lqd", label: "LQD", valueUsd: 41e9, changePct: -0.37, detail: "iShares iBoxx Investment Grade Corporate Bond ETF." },
          { id: "etf-hyg", label: "HYG", valueUsd: 17e9, changePct: -0.24, detail: "iShares High Yield Corporate Bond ETF." }
        ]
      },
      {
        id: "etf-commodity",
        title: "Commodity ETFs",
        description: "Commodity wrappers sized by ETF AUM.",
        tiles: [
          { id: "etf-gld", label: "GLD", valueUsd: 75e9, changePct: -1.29, detail: "SPDR Gold Shares." },
          { id: "etf-iau", label: "IAU", valueUsd: 34e9, changePct: -1.33, detail: "iShares Gold Trust." },
          { id: "etf-slv", label: "SLV", valueUsd: 16e9, changePct: -4.96, detail: "iShares Silver Trust." },
          { id: "etf-gldm", label: "GLDM", valueUsd: 12e9, changePct: -1.31, detail: "SPDR Gold MiniShares Trust." }
        ]
      },
      {
        id: "etf-currency-digital",
        title: "Currency and Digital Asset ETFs",
        description: "Currency wrappers and digital-asset ETF proxies.",
        tiles: [
          { id: "etf-ibit", label: "IBIT", valueUsd: 56e9, changePct: 2.74, detail: "iShares Bitcoin Trust ETF." },
          { id: "etf-fbtc", label: "FBTC", valueUsd: 19e9, changePct: 2.31, detail: "Fidelity Wise Origin Bitcoin Fund." },
          { id: "etf-etha", label: "ETHA", valueUsd: 6e9, changePct: 1.82, detail: "iShares Ethereum Trust ETF." },
          { id: "etf-bito", label: "BITO", valueUsd: 3.2e9, changePct: 1.05, detail: "ProShares Bitcoin Strategy ETF." },
          { id: "etf-uup", label: "UUP", valueUsd: 2.4e9, changePct: 0.31, detail: "Invesco DB US Dollar Index Bullish Fund." },
          { id: "etf-fxe", label: "FXE", valueUsd: 1.8e9, changePct: 0.15, detail: "Invesco CurrencyShares Euro Trust." }
        ]
      },
      {
        id: "etf-alternatives",
        title: "Alternative ETFs",
        description: "Income, real estate, and alternative wrapper AUM.",
        tiles: [
          { id: "etf-vnq", label: "VNQ", valueUsd: 36e9, changePct: 0.16, detail: "Vanguard Real Estate ETF." },
          { id: "etf-jepi", label: "JEPI", valueUsd: 34e9, changePct: -0.16, detail: "JPMorgan Equity Premium Income ETF." },
          { id: "etf-jepq", label: "JEPQ", valueUsd: 18e9, changePct: -0.53, detail: "JPMorgan Nasdaq Equity Premium Income ETF." },
          { id: "etf-gdx", label: "GDX", valueUsd: 12e9, changePct: -6.08, detail: "VanEck Gold Miners ETF." }
        ]
      }
    ]
  },
  {
    id: "money-and-reserves",
    title: "Money Supply and Official Reserves",
    description:
      "Separate heatmap for monetary aggregates, central-bank balance sheets, and official reserve pools because these values are large enough to distort the market heatmap.",
    note:
      "These figures are monetary or reserve-stock proxies rather than investable market caps, and they overlap with the broader financial system.",
    groups: [
      {
        id: "m2",
        title: "M2 / Broad Money",
        description: "Country-level broad money pools in USD terms.",
        tiles: [
          { id: "m2-china", label: "China M2", valueUsd: 42.1e12, changePct: 8.2, detail: "Broad money aggregate in USD." },
          { id: "m2-us", label: "US M2", valueUsd: 21.2e12, changePct: 3.3, detail: "Broad money aggregate in USD." },
          { id: "m2-euro", label: "Euro Area M2", valueUsd: 16.3e12, changePct: 2.0, detail: "Broad money aggregate in USD." },
          { id: "m2-japan", label: "Japan M2", valueUsd: 10.2e12, changePct: 1.5, detail: "Broad money aggregate in USD." },
          { id: "m2-uk", label: "UK M2", valueUsd: 4.1e12, changePct: 1.7, detail: "Broad money aggregate in USD." },
          { id: "m2-india", label: "India M2", valueUsd: 3.9e12, changePct: 9.1, detail: "Broad money aggregate in USD." },
          { id: "m2-other-asia", label: "Other Asia M2", valueUsd: 12.4e12, changePct: 6.2, detail: "Broad money across major Asian economies combined." },
          { id: "m2-rest", label: "Rest of World M2", valueUsd: 18.8e12, changePct: 4.7, detail: "Other national broad money pools combined." }
        ]
      },
      {
        id: "m1",
        title: "M1 / Transaction Money",
        description: "High-liquidity money by country in USD terms.",
        tiles: [
          { id: "m1-us", label: "US M1", valueUsd: 18e12, changePct: -1.8, detail: "Transaction money aggregate in USD." },
          { id: "m1-euro", label: "Euro Area M1", valueUsd: 11e12, changePct: 0.9, detail: "Transaction money aggregate in USD." },
          { id: "m1-china", label: "China M1", valueUsd: 9e12, changePct: 1.8, detail: "Transaction money aggregate in USD." },
          { id: "m1-japan", label: "Japan M1", valueUsd: 7.6e12, changePct: 2.5, detail: "Transaction money aggregate in USD." },
          { id: "m1-uk", label: "UK M1", valueUsd: 1.8e12, changePct: 2.1, detail: "Transaction money aggregate in USD." },
          { id: "m1-rest", label: "Rest of World M1", valueUsd: 12.2e12, changePct: 5.0, detail: "Other national M1 pools combined." }
        ]
      },
      {
        id: "central-banks",
        title: "Central Bank Balance Sheets",
        description: "Major central-bank asset pools.",
        tiles: [
          { id: "cb-fed", label: "Federal Reserve", valueUsd: 7.1e12, changePct: -4.0, detail: "Fed balance-sheet assets." },
          { id: "cb-ecb", label: "ECB / Eurosystem", valueUsd: 7.4e12, changePct: -2.6, detail: "ECB and national Eurosystem assets." },
          { id: "cb-pboc", label: "PBoC", valueUsd: 6.3e12, changePct: 2.0, detail: "People's Bank of China assets." },
          { id: "cb-boj", label: "BoJ", valueUsd: 5.2e12, changePct: 0.5, detail: "Bank of Japan assets." },
          { id: "cb-boe", label: "BoE", valueUsd: 0.9e12, changePct: -3.7, detail: "Bank of England assets." },
          { id: "cb-snb", label: "SNB", valueUsd: 0.8e12, changePct: -1.2, detail: "Swiss National Bank assets." },
          { id: "cb-other", label: "Other Central Banks", valueUsd: 3.8e12, changePct: 1.9, detail: "Other central-bank balance sheets combined." }
        ]
      },
      {
        id: "official-reserves",
        title: "Official Reserves and SWFs",
        description: "FX reserves, reserve portfolios, and sovereign wealth pools.",
        tiles: [
          { id: "res-china", label: "China FX Reserves", valueUsd: 3.2e12, changePct: 0.6, detail: "Official foreign exchange reserves." },
          { id: "res-japan", label: "Japan FX Reserves", valueUsd: 1.2e12, changePct: 0.4, detail: "Official foreign exchange reserves." },
          { id: "res-swiss", label: "Swiss FX Reserves", valueUsd: 0.9e12, changePct: -0.2, detail: "Official foreign exchange reserves." },
          { id: "res-india", label: "India FX Reserves", valueUsd: 0.7e12, changePct: 0.9, detail: "Official foreign exchange reserves." },
          { id: "res-gulf", label: "Gulf Official Pools", valueUsd: 1.6e12, changePct: 1.2, detail: "Saudi and Gulf reserve portfolios combined." },
          { id: "res-singapore-hk", label: "Singapore / Hong Kong", valueUsd: 1e12, changePct: 0.5, detail: "Official reserve pools combined." },
          { id: "res-swf", label: "Sovereign Wealth Funds", valueUsd: 5.6e12, changePct: 2.3, detail: "Global SWF asset pools combined." },
          { id: "res-multilateral", label: "Multilateral Official Pools", valueUsd: 0.9e12, changePct: 0.1, detail: "IMF and other official reserve facilities." }
        ]
      }
    ]
  },
  {
    id: "debt-and-assets",
    title: "Debt and Balance-Sheet Assets",
    description:
      "Separate heatmap for debt, bank assets, real assets, and institutional capital pools so the dashboard can compare what is financed, owed, or warehoused.",
    note:
      "This is a gross system view. Debt and asset pools overlap with one another, so the section is best read as where value is warehoused, not as net wealth.",
    groups: [
      {
        id: "debt-stack",
        title: "Debt Stack",
        description: "Global debt divided by category and sector.",
        tiles: [
          { id: "debt-sovereign", label: "Sovereign Debt", valueUsd: 98e12, changePct: 3.9, detail: "Global government debt outstanding." },
          { id: "debt-corporate", label: "Corporate Debt", valueUsd: 91e12, changePct: 4.2, detail: "Non-financial corporate bonds and loans." },
          { id: "debt-household", label: "Household Mortgages", valueUsd: 54e12, changePct: 2.2, detail: "Residential mortgage debt." },
          { id: "debt-financial", label: "Financial Sector Debt", valueUsd: 73e12, changePct: 3.0, detail: "Bank and non-bank financial debt." },
          { id: "debt-consumer", label: "Consumer Credit", valueUsd: 18e12, changePct: 2.8, detail: "Credit card, auto, and personal lending." },
          { id: "debt-em", label: "EM External Debt", valueUsd: 11e12, changePct: 1.6, detail: "Emerging-market external debt." }
        ]
      },
      {
        id: "managed-assets",
        title: "Institutional Asset Pools",
        description: "Debt, equity, and alternatives held by long-term allocators and fund vehicles.",
        tiles: [
          { id: "assets-mutual", label: "Mutual Funds / ETFs", valueUsd: 84e12, changePct: 6.0, detail: "Global fund AUM." },
          { id: "assets-pensions", label: "Pension Assets", valueUsd: 58e12, changePct: 5.1, detail: "Global pension assets." },
          { id: "assets-insurance", label: "Insurance General Accounts", valueUsd: 41e12, changePct: 3.3, detail: "Life and P&C insurer asset pools." },
          { id: "assets-hedge", label: "Hedge Funds", valueUsd: 4.7e12, changePct: 2.9, detail: "Global hedge-fund AUM." },
          { id: "assets-pe", label: "Private Equity", valueUsd: 8.5e12, changePct: 2.0, detail: "Private-equity AUM." },
          { id: "assets-private-credit", label: "Private Credit", valueUsd: 2.3e12, changePct: 9.2, detail: "Private-credit AUM." },
          { id: "assets-endowments", label: "Endowments / Foundations", valueUsd: 1.7e12, changePct: 1.5, detail: "University and foundation asset pools." }
        ]
      },
      {
        id: "real-assets",
        title: "Real Assets",
        description: "Large physical asset pools that compete for capital allocation.",
        tiles: [
          { id: "real-resi", label: "Residential Real Estate", valueUsd: 280e12, changePct: 1.4, detail: "Global residential property value." },
          { id: "real-cre", label: "Commercial Real Estate", valueUsd: 38e12, changePct: -1.7, detail: "Global commercial property value." },
          { id: "real-infra", label: "Infrastructure", valueUsd: 17e12, changePct: 2.0, detail: "Transport, utilities, and core infrastructure assets." },
          { id: "real-farmland", label: "Farmland / Timber", valueUsd: 9.4e12, changePct: 1.1, detail: "Agricultural land and timberland assets." }
        ]
      },
      {
        id: "banking-system",
        title: "Banking and Shadow Finance",
        description: "Balance-sheet capacity across banks, money-market funds, and non-bank leverage.",
        tiles: [
          { id: "banks-gsib", label: "GSIB Assets", valueUsd: 61e12, changePct: 2.8, detail: "Assets held by globally systemic banks." },
          { id: "banks-regional", label: "Regional Bank Assets", valueUsd: 32e12, changePct: 1.6, detail: "Regional and domestic bank assets." },
          { id: "banks-shadow", label: "Shadow Banking", valueUsd: 64e12, changePct: 3.3, detail: "Non-bank financial intermediation assets." },
          { id: "banks-custody", label: "Custodial / Clearing Pools", valueUsd: 12e12, changePct: 1.0, detail: "Central clearing, collateral, and custody pools." },
          { id: "banks-mmf", label: "Money Market Funds", valueUsd: 9.5e12, changePct: 6.7, detail: "Global money-market fund assets." }
        ]
      }
    ]
  }
];

function round(value) {
  return Number(value.toFixed(2));
}

const SPARKLINE_LOOKBACKS = {
  "24H": { points: 24, scale: 0.85, volatility: 0.55 },
  "7D": { points: 28, scale: 1.1, volatility: 0.7 },
  "30D": { points: 32, scale: 1.75, volatility: 0.9 },
  "180D": { points: 36, scale: 3.2, volatility: 1.1 },
  "365D": { points: 40, scale: 4.4, volatility: 1.25 },
  MAX: { points: 44, scale: 5.8, volatility: 1.45 }
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createSeededRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function formatCompactUsd(value) {
  const absoluteValue = Math.abs(value);
  const units = [
    { threshold: 1e15, suffix: "Q" },
    { threshold: 1e12, suffix: "T" },
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "K" }
  ];

  for (const unit of units) {
    if (absoluteValue >= unit.threshold) {
      const scaled = value / unit.threshold;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `$${scaled.toFixed(digits)}${unit.suffix}`;
    }
  }

  return `$${value.toFixed(0)}`;
}

function buildSparklineSeries(tile, lookback) {
  const config = SPARKLINE_LOOKBACKS[lookback];
  const seededRandom = createSeededRandom(hashString(`${tile.id}:${lookback}`));
  const targetChangePct = clamp(tile.changePct * config.scale, -36, 36);
  const startRelative = 100 / (1 + targetChangePct / 100);
  const frequencyA = 1.2 + seededRandom() * 1.6;
  const frequencyB = 2.8 + seededRandom() * 2.3;
  const phaseA = seededRandom() * Math.PI * 2;
  const phaseB = seededRandom() * Math.PI * 2;
  const dipCenter = 0.18 + seededRandom() * 0.36;
  const dipWidth = 0.08 + seededRandom() * 0.08;
  const dipDepth = (0.25 + seededRandom() * 0.3) * config.volatility;
  const humpCenter = 0.48 + seededRandom() * 0.28;
  const humpWidth = 0.07 + seededRandom() * 0.08;
  const humpHeight = (0.18 + seededRandom() * 0.24) * config.volatility;
  const slopeBias = (seededRandom() - 0.5) * config.volatility * 0.8;
  const wobbleScale = Math.max(0.4, Math.abs(targetChangePct) * 0.12 + config.volatility);
  const points = Array.from({ length: config.points }, (_value, index) => {
    const t = index / (config.points - 1);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const trend = startRelative + (100 - startRelative) * eased;
    const wave =
      Math.sin(t * Math.PI * frequencyA + phaseA) * wobbleScale * 0.72 +
      Math.cos(t * Math.PI * frequencyB + phaseB) * wobbleScale * 0.28;
    const dip = -Math.exp(-Math.pow((t - dipCenter) / dipWidth, 2)) * dipDepth;
    const hump = Math.exp(-Math.pow((t - humpCenter) / humpWidth, 2)) * humpHeight;
    const biased = trend + wave + dip + hump + slopeBias * (1 - t);
    const relativeValue = clamp(biased, startRelative * 0.55, 160);

    return round(tile.valueUsd * (relativeValue / 100));
  });

  points[0] = round(tile.valueUsd * (startRelative / 100));
  points[points.length - 1] = round(tile.valueUsd);

  return points;
}

function buildTileSparklines(tile) {
  return Object.fromEntries(
    Object.keys(SPARKLINE_LOOKBACKS).map((lookback) => [lookback, buildSparklineSeries(tile, lookback)])
  );
}

function summarizeTiles(tiles) {
  const totalValueUsd = tiles.reduce((sum, tile) => sum + tile.valueUsd, 0);
  const weightedChangePct =
    totalValueUsd > 0
      ? tiles.reduce((sum, tile) => sum + tile.valueUsd * tile.changePct, 0) / totalValueUsd
      : 0;

  return {
    totalValueUsd,
    weightedChangePct: round(weightedChangePct)
  };
}

function buildSection(section) {
  const groups = section.groups.map((group) => {
    const tiles = group.tiles.map((tile) => ({
      ...tile,
      changeUsd: round((tile.valueUsd * tile.changePct) / 100),
      sparklines: buildTileSparklines(tile)
    }));
    const summary = summarizeTiles(tiles);

    return {
      ...group,
      tiles,
      totalValueUsd: summary.totalValueUsd,
      weightedChangePct: summary.weightedChangePct
    };
  });

  const tiles = groups.flatMap((group) =>
    group.tiles.map((tile) => ({
      ...tile,
      groupId: group.id,
      groupTitle: group.title
    }))
  );
  const summary = summarizeTiles(tiles);

  return {
    ...section,
    groups,
    totalValueUsd: summary.totalValueUsd,
    weightedChangePct: summary.weightedChangePct
  };
}

export function buildMacroDashboardPayload() {
  const sections = macroHeatmapCatalog.map(buildSection);
  const allTiles = sections.flatMap((section) =>
    section.groups.flatMap((group) =>
      group.tiles.map((tile) => ({
        ...tile,
        sectionId: section.id,
        sectionTitle: section.title,
        groupId: group.id,
        groupTitle: group.title
      }))
    )
  );

  const grossTrackedValueUsd = sections.reduce((sum, section) => sum + section.totalValueUsd, 0);
  const riskMarketsValueUsd = sections
    .filter((section) => ["global-markets", "etf-heatmap"].includes(section.id))
    .reduce((sum, section) => sum + section.totalValueUsd, 0);
  const moneyValueUsd = sections.find((section) => section.id === "money-and-reserves")?.totalValueUsd ?? 0;
  const debtAndAssetsValueUsd = sections.find((section) => section.id === "debt-and-assets")?.totalValueUsd ?? 0;
  const positiveChangeUsd = allTiles.reduce((sum, tile) => sum + Math.max(tile.changeUsd, 0), 0);
  const negativeChangeUsd = allTiles.reduce((sum, tile) => sum + Math.min(tile.changeUsd, 0), 0);

  return {
    sections,
    lookbacks: Object.keys(SPARKLINE_LOOKBACKS),
    defaultLookback: "30D",
    totals: {
      grossTrackedValueUsd,
      riskMarketsValueUsd,
      moneyValueUsd,
      debtAndAssetsValueUsd
    },
    flowSummary: {
      positiveChangeUsd,
      negativeChangeUsd,
      netChangeUsd: round(positiveChangeUsd + negativeChangeUsd),
      largestInflows: [...allTiles]
        .sort((left, right) => right.changeUsd - left.changeUsd)
        .slice(0, 5),
      largestOutflows: [...allTiles]
        .sort((left, right) => left.changeUsd - right.changeUsd)
        .slice(0, 5)
    },
    methodology: [
      "Tile area represents USD value, not spot price.",
      "Color shows estimated value expansion or contraction for each pool.",
      "Tile sparklines are normalized lookback proxies anchored to the current USD value for each pool.",
      "Stocks and crypto use market-cap style estimates; ETFs use AUM; bonds, FX, commodities, money, and balance sheets use outstanding-value or reserve proxies.",
      "The current release uses curated baseline estimates inside the app, with the live watchlist and strategy data acting as the real-time overlay.",
      "The gross total intentionally includes overlap across money, debt, and asset pools so you can compare scale, not calculate net wealth."
    ]
  };
}

export function buildMacroHeroStats(macroDashboard) {
  const {
    grossTrackedValueUsd,
    riskMarketsValueUsd,
    moneyValueUsd,
    debtAndAssetsValueUsd
  } = macroDashboard.totals;

  return [
    { label: "Gross Tracked Value", value: formatCompactUsd(grossTrackedValueUsd), accent: "amber" },
    { label: "Markets Heatmap", value: formatCompactUsd(riskMarketsValueUsd), accent: "emerald" },
    { label: "Money / Reserves", value: formatCompactUsd(moneyValueUsd), accent: "sky" },
    { label: "Debt / Assets", value: formatCompactUsd(debtAndAssetsValueUsd), accent: "rose" }
  ];
}
