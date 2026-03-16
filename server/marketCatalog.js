export const quoteWatchlist = [
  { symbol: "SPX", sourceSymbol: "^spx", label: "S&P 500 Index", group: "US Indices", provider: "stooq" },
  { symbol: "RUT", sourceSymbol: "iwm.us", label: "Russell 2000 Index", group: "US Indices", provider: "stooq" },
  { symbol: "US2K", sourceSymbol: "iwm.us", label: "US Small Cap 2000 Index", group: "US Indices", provider: "stooq" },
  { symbol: "DJI", sourceSymbol: "^dji", label: "Dow Jones Industrial Average Index", group: "US Indices", provider: "stooq" },
  { symbol: "QQQ", sourceSymbol: "qqq.us", label: "Invesco QQQ Trust, Series 1", group: "US Indices", provider: "stooq" },
  { symbol: "SPY", sourceSymbol: "spy.us", label: "SPDR S&P 500 ETF Trust", group: "US Indices", provider: "stooq" },
  { symbol: "VIX", sourceSymbol: "vixy.us", label: "Volatility S&P 500 Index", group: "US Indices", provider: "stooq" },
  { symbol: "VOO", sourceSymbol: "voo.us", label: "Vanguard S&P 500 ETF", group: "US Stocks", provider: "stooq" },
  { symbol: "EWU", sourceSymbol: "ewu.us", label: "UK Equity ETF", group: "UK Stocks", provider: "stooq" },
  { symbol: "VGK", sourceSymbol: "vgk.us", label: "Europe ETF", group: "EU Stocks", provider: "stooq" },
  { symbol: "GLD", sourceSymbol: "gld.us", label: "Gold ETF", group: "Commodities", provider: "stooq" },
  { symbol: "USO", sourceSymbol: "uso.us", label: "Oil ETF", group: "Commodities", provider: "stooq" },
  { symbol: "TLT", sourceSymbol: "tlt.us", label: "US Treasury ETF", group: "Bonds", provider: "stooq" },
  { symbol: "BTC-USD", sourceSymbol: "bitcoin", label: "Bitcoin", group: "Crypto", provider: "coingecko" },
  { symbol: "ETH-USD", sourceSymbol: "ethereum", label: "Ethereum", group: "Crypto", provider: "coingecko" },
  { symbol: "FXE", sourceSymbol: "fxe.us", label: "Euro FX ETF", group: "Forex", provider: "stooq" },
  { symbol: "FXB", sourceSymbol: "fxb.us", label: "Pound FX ETF", group: "Forex", provider: "stooq" },
  { symbol: "UUP", sourceSymbol: "uup.us", label: "Dollar Index ETF", group: "Global Trade", provider: "stooq" },
  { symbol: "SEA", sourceSymbol: "sea.us", label: "Shipping ETF", group: "Global Trade", provider: "stooq" },
  { symbol: "IBIT", sourceSymbol: "ibit.us", label: "iShares Bitcoin Trust", group: "Strategy Proxy", provider: "stooq" }
];

export const marketSections = [
  {
    id: "us-stocks",
    title: "US Stock Market",
    tone: "amber",
    description: "Index leadership, beta, and volatility across the US session.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        largeChartUrl: "",
        isTransparent: false,
        showSymbolLogo: true,
        showFloatingTooltip: false,
        width: "100%",
        height: 420,
        plotLineColorGrowing: "rgba(245, 158, 11, 1)",
        plotLineColorFalling: "rgba(239, 68, 68, 1)",
        gridLineColor: "rgba(255, 255, 255, 0.04)",
        scaleFontColor: "rgba(255, 255, 255, 0.7)",
        belowLineFillColorGrowing: "rgba(245, 158, 11, 0.12)",
        belowLineFillColorFalling: "rgba(239, 68, 68, 0.08)",
        belowLineFillColorGrowingBottom: "rgba(245, 158, 11, 0.02)",
        belowLineFillColorFallingBottom: "rgba(239, 68, 68, 0.02)",
        symbolActiveColor: "rgba(245, 158, 11, 0.18)",
        tabs: [
          {
            title: "Core",
            symbols: [
              { s: "SP:SPX", d: "S&P 500" },
              { s: "NASDAQ:NDX", d: "Nasdaq 100" },
              { s: "CBOE:VIX", d: "VIX" },
              { s: "AMEX:IWM", d: "Russell 2000" }
            ]
          }
        ]
      }
    }
  },
  {
    id: "uk-stocks",
    title: "UK Stock Market",
    tone: "teal",
    description: "FTSE complex and large-cap sector exposure for London hours.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        isTransparent: false,
        width: "100%",
        height: 420,
        tabs: [
          {
            title: "London",
            symbols: [
              { s: "FXOPEN:UK100", d: "FTSE 100" },
              { s: "LSE:SHEL", d: "Shell" },
              { s: "LSE:HSBA", d: "HSBC" },
              { s: "LSE:BP.", d: "BP" }
            ]
          }
        ]
      }
    }
  },
  {
    id: "eu-stocks",
    title: "EU Stock Markets",
    tone: "slate",
    description: "Continental equity pulse with Germany, France, and eurozone risk.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        isTransparent: false,
        width: "100%",
        height: 420,
        tabs: [
          {
            title: "Europe",
            symbols: [
              { s: "XETR:DAX", d: "DAX" },
              { s: "TVC:CAC40", d: "CAC 40" },
              { s: "EUREX:V2TX", d: "Euro Stoxx Vol" },
              { s: "XETR:SAP", d: "SAP" }
            ]
          }
        ]
      }
    }
  },
  {
    id: "commodities",
    title: "Commodity Markets",
    tone: "gold",
    description: "Precious metals, energy, and industrial materials.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        isTransparent: false,
        width: "100%",
        height: 420,
        tabs: [
          {
            title: "Commodities",
            symbols: [
              { s: "COMEX:GC1!", d: "Gold" },
              { s: "NYMEX:CL1!", d: "WTI" },
              { s: "NYMEX:NG1!", d: "Nat Gas" },
              { s: "COMEX:HG1!", d: "Copper" }
            ]
          }
        ]
      }
    }
  },
  {
    id: "bonds",
    title: "Bond Markets",
    tone: "blue",
    description: "Rates, term structure stress, and sovereign yield benchmarks.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        isTransparent: false,
        width: "100%",
        height: 420,
        tabs: [
          {
            title: "Rates",
            symbols: [
              { s: "TVC:US10Y", d: "US 10Y" },
              { s: "TVC:UK10Y", d: "UK 10Y" },
              { s: "TVC:DE10Y", d: "DE 10Y" },
              { s: "CME:ZB1!", d: "US 30Y Bond Fut" }
            ]
          }
        ]
      }
    }
  },
  {
    id: "crypto",
    title: "Crypto Markets",
    tone: "emerald",
    description: "Spot, ETF proxies, and the crypto risk stack.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        isTransparent: false,
        width: "100%",
        height: 420,
        tabs: [
          {
            title: "Crypto",
            symbols: [
              { s: "BINANCE:BTCUSDT", d: "BTC" },
              { s: "BINANCE:ETHUSDT", d: "ETH" },
              { s: "NASDAQ:IBIT", d: "IBIT" },
              { s: "NASDAQ:ETHA", d: "ETHA" }
            ]
          }
        ]
      }
    }
  },
  {
    id: "forex",
    title: "Forex Markets",
    tone: "rose",
    description: "Major FX crosses for USD and European macro risk.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        isTransparent: false,
        width: "100%",
        height: 420,
        tabs: [
          {
            title: "FX",
            symbols: [
              { s: "FX:EURUSD", d: "EUR/USD" },
              { s: "FX:GBPUSD", d: "GBP/USD" },
              { s: "FX:USDJPY", d: "USD/JPY" },
              { s: "TVC:DXY", d: "DXY" }
            ]
          }
        ]
      }
    }
  },
  {
    id: "global-trade",
    title: "Global Trade Markets",
    tone: "sky",
    description: "Cross-asset trade proxies: dollar, copper, shipping, and oil.",
    widget: {
      type: "market-overview",
      config: {
        colorTheme: "dark",
        dateRange: "12M",
        showChart: true,
        locale: "en",
        isTransparent: false,
        width: "100%",
        height: 420,
        tabs: [
          {
            title: "Trade Pulse",
            symbols: [
              { s: "TVC:DXY", d: "Dollar Index" },
              { s: "COMEX:HG1!", d: "Copper" },
              { s: "NYSEARCA:SEA", d: "Shipping ETF" },
              { s: "NYMEX:CL1!", d: "WTI" }
            ]
          }
        ]
      }
    }
  }
];

export const calendarWidgets = {
  economicCalendar: {
    type: "economic-calendar",
    config: {
      colorTheme: "dark",
      isTransparent: true,
      width: "100%",
      height: 520,
      locale: "en",
      importanceFilter: "-1,0,1"
    }
  },
  events: {
    type: "events",
    config: {
      colorTheme: "dark",
      isTransparent: false,
      width: "100%",
      height: 520,
      locale: "en",
      symbol: "NASDAQ:IBIT"
    }
  },
  tickerTape: {
    type: "ticker-tape",
    config: {
      symbols: [
        { proName: "FOREXCOM:SPXUSD", title: "S&P 500" },
        { proName: "FOREXCOM:DJI", title: "DJI" },
        { proName: "NASDAQ:IBIT", title: "IBIT" },
        { proName: "CAPITALCOM:VIX", title: "VIX" },
        { proName: "INDEX:S5FI", title: "S5FI" },
        { proName: "FOREXCOM:NSXUSD", title: "NSXUSD" },
        { proName: "BINANCE:BTCUSDT", title: "Bitcoin" },
        { proName: "BINANCE:ETHUSDT", title: "Ethereum" },
        { proName: "CMCMARKETS:GOLD", title: "Gold" },
        { proName: "TVC:USOIL", title: "WTI" },
        { proName: "FX:EURUSD", title: "EUR/USD" },
        { proName: "FPMARKETS:GBPUSD", title: "GBPUSD" },
        { proName: "FX_IDC:GBPCNY", title: "GBPCNY" },
        { proName: "FX_IDC:GBPEUR", title: "GBPEUR" },
        { proName: "FX_IDC:USDCNY", title: "USDCNY" }
      ],
      showSymbolLogo: true,
      isTransparent: false,
      displayMode: "adaptive",
      colorTheme: "dark",
      locale: "en"
    }
  },
  advancedChart: {
    type: "advanced-chart",
    config: {
      autosize: true,
      symbol: "NASDAQ:IBIT",
      interval: "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: true,
      backgroundColor: "rgba(11, 18, 32, 0)",
      gridColor: "rgba(148, 163, 184, 0.12)",
      hide_side_toolbar: false,
      hide_top_toolbar: false,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com"
    }
  }
};

export const sidebarStrategies = [
  {
    id: "strategy-1",
    name: "BTC Threshold Hedge",
    status: "ready",
    assetLabel: "BTC / IBIT",
    description: "Buy a Bitcoin Polymarket contract and offset the cost with an IBIT call overlay."
  },
  {
    id: "strategy-2",
    name: "Vol Crush Earnings",
    status: "planned",
    assetLabel: "Single-name stocks",
    description: "Pair event contracts with short premium around earnings and statement dates."
  },
  {
    id: "strategy-3",
    name: "Macro Breakout Overlay",
    status: "planned",
    assetLabel: "Gold / Oil / FX",
    description: "Use binary macro views to finance short-dated optionality."
  }
];

export const defaultStrategyConfig = {
  id: "strategy-1",
  name: "Bitcoin March Hedge",
  bankroll: 2000,
  yesLeg: {
    allocation: 1000,
    price: 0.28,
    query: "bitcoin 80000",
    targetLabel: "BTC over 80k by March 31",
    targetValue: 80000,
    payoutOnYes: 1
  },
  optionLeg: {
    allocation: 1000,
    side: "short_call",
    symbol: "IBIT",
    proxyUnderlying: "BTC-USD",
    strike: 46,
    premium: 0.23,
    expiry: "2026-03-31",
    impliedVolatility: 0.68,
    riskFreeRate: 0.0425
  }
};

export const strategyAssetUniverse = [
  {
    id: "btc",
    label: "Bitcoin",
    polymarketQueries: ["bitcoin above", "bitcoin march", "btc above"],
    optionSymbol: "IBIT",
    underlyingSymbol: "BTC-USD",
    referenceSymbol: "NASDAQ:IBIT",
    conversionFallback: 0.00057
  },
  {
    id: "eth",
    label: "Ethereum",
    polymarketQueries: ["ethereum above", "eth march", "ethereum march"],
    optionSymbol: "ETHA",
    underlyingSymbol: "ETH-USD",
    referenceSymbol: "NASDAQ:ETHA",
    conversionFallback: 0.01
  },
  {
    id: "gold",
    label: "Gold",
    polymarketQueries: ["gold above", "gold march", "gold price"],
    optionSymbol: "GLD",
    underlyingSymbol: "XAU-USD",
    referenceSymbol: "AMEX:GLD",
    conversionFallback: 0.1
  },
  {
    id: "oil",
    label: "Oil",
    polymarketQueries: ["oil above", "wti march", "brent march"],
    optionSymbol: "USO",
    underlyingSymbol: "WTI-USD",
    referenceSymbol: "AMEX:USO",
    conversionFallback: 1
  },
  {
    id: "stocks",
    label: "US Stocks",
    polymarketQueries: ["spx above", "s&p 500 above", "s&p 500 close"],
    optionSymbol: "VOO",
    underlyingSymbol: "SPX-INDEX",
    referenceSymbol: "AMEX:VOO",
    conversionFallback: 0.091
  }
];

export const fallbackPolymarketMarkets = [
  {
    id: "seed-btc-mar-31",
    assetId: "btc",
    question: "Will Bitcoin be above $80,000 on March 31, 2026?",
    yesPrice: 0.28,
    noPrice: 0.72,
    volume: 0,
    liquidity: 0,
    endDate: "2026-03-31T12:00:00Z",
    active: true,
    source: "seed",
    url: "https://polymarket.com/event/what-price-will-bitcoin-hit-in-march-2026"
  },
  {
    id: "seed-btc-apr-30",
    assetId: "btc",
    question: "Will Bitcoin be above $85,000 on April 30, 2026?",
    yesPrice: 0.19,
    noPrice: 0.81,
    volume: 0,
    liquidity: 0,
    endDate: "2026-04-30T12:00:00Z",
    active: true,
    source: "seed",
    url: "https://polymarket.com/"
  },
  {
    id: "seed-eth-mar-31",
    assetId: "eth",
    question: "Will Ethereum be above $2,500 on March 31, 2026?",
    yesPrice: 0.34,
    noPrice: 0.66,
    volume: 0,
    liquidity: 0,
    endDate: "2026-03-31T12:00:00Z",
    active: true,
    source: "seed",
    url: "https://polymarket.com/event/what-price-will-ethereum-hit-in-march-2026"
  },
  {
    id: "seed-eth-apr-30",
    assetId: "eth",
    question: "Will Ethereum be above $3,000 on April 30, 2026?",
    yesPrice: 0.21,
    noPrice: 0.79,
    volume: 0,
    liquidity: 0,
    endDate: "2026-04-30T12:00:00Z",
    active: true,
    source: "seed",
    url: "https://polymarket.com/"
  },
  {
    id: "seed-gold-apr-30",
    assetId: "gold",
    question: "Will Gold be above $3,000 on April 30, 2026?",
    yesPrice: 0.31,
    noPrice: 0.69,
    volume: 0,
    liquidity: 0,
    endDate: "2026-04-30T12:00:00Z",
    active: true,
    source: "seed",
    url: "https://polymarket.com/"
  },
  {
    id: "seed-oil-apr-30",
    assetId: "oil",
    question: "Will WTI oil be above $90 on April 30, 2026?",
    yesPrice: 0.27,
    noPrice: 0.73,
    volume: 0,
    liquidity: 0,
    endDate: "2026-04-30T12:00:00Z",
    active: true,
    source: "seed",
    url: "https://polymarket.com/"
  },
  {
    id: "seed-stocks-mar-31",
    assetId: "stocks",
    question: "Will the S&P 500 (SPX) be above 6,500 on March 31, 2026?",
    yesPrice: 0.489,
    noPrice: 0.511,
    volume: 0,
    liquidity: 0,
    endDate: "2026-03-31T20:00:00Z",
    active: true,
    source: "seed",
    url: "https://polymarket.com/event/sp-500-spx-above-end-of-march"
  }
];
