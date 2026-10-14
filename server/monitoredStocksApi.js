import {
  listMonitoredStocks,
  insertMonitoredStock,
  deleteMonitoredStock,
  countMonitoredStocks,
  getMaxMonitoredStocks,
  listTigerIvHistory,
} from './db.js';
import { tigerQuotes } from './providers/tiger.js';

// True once the nightly job has stored any shared Tiger IV history for the symbol.
function hasIvHistory(symbol) {
  try {
    return listTigerIvHistory(symbol, 1).length > 0;
  } catch {
    return false;
  }
}

export async function getMonitoredStocks(userId) {
  const rows = listMonitoredStocks(userId);
  const symbols = rows.map(r => r.symbol);
  const maxSlots = getMaxMonitoredStocks(userId);

  if (symbols.length === 0) {
    return { stocks: [], maxSlots, usedSlots: 0 };
  }

  try {
    const quotes = await tigerQuotes(symbols);
    const stocks = quotes.map(q => {
      // Tiger supplies today's change; change_rate is a fraction (-0.0047 = -0.47%).
      const priceChange = q.change ?? 0;
      const percentChange = (q.changeRate ?? 0) * 100;
      return {
        symbol: q.symbol,
        price: q.regularMarketPrice,
        priceChange: parseFloat(priceChange.toFixed(2)),
        percentChange: parseFloat(percentChange.toFixed(2)),
        direction: priceChange >= 0 ? 'up' : 'down',
        lastUpdated: q.regularMarketTime,
        ivHistory: hasIvHistory(q.symbol),
      };
    });
    return { stocks, maxSlots, usedSlots: symbols.length };
  } catch {
    // Return symbols without prices if quotes fail
    return {
      stocks: symbols.map(s => ({
        symbol: s, price: null, priceChange: null,
        percentChange: null, direction: null, lastUpdated: null,
        ivHistory: hasIvHistory(s),
      })),
      maxSlots,
      usedSlots: symbols.length,
    };
  }
}

export async function addMonitoredStock(userId, symbol) {
  const maxSlots = getMaxMonitoredStocks(userId);
  const used = countMonitoredStocks(userId);

  if (used >= maxSlots) {
    throw new Error(`Maximum monitored stocks limit (${maxSlots}) reached`);
  }

  insertMonitoredStock(userId, symbol);
  return { symbol: symbol.toUpperCase(), success: true };
}

export async function removeMonitoredStock(userId, symbol) {
  const before = countMonitoredStocks(userId);
  deleteMonitoredStock(userId, symbol);
  const after = countMonitoredStocks(userId);

  if (before === after) {
    throw new Error(`Stock ${symbol} not found in your monitored list`);
  }

  return { symbol: symbol.toUpperCase(), success: true };
}

export function getUserMonitoredStockLimit(userId) {
  const maxSlots = getMaxMonitoredStocks(userId);
  const usedSlots = countMonitoredStocks(userId);
  return { maxSlots, usedSlots, availableSlots: maxSlots - usedSlots };
}
