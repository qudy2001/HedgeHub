import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import '../styles/monitored-stocks.css';
import DataPendingBadge from './DataPendingBadge.jsx';

const DEMO_STOCKS = [
  { symbol: 'AAPL', price: 220.45, percentChange: 2.3, direction: 'up', lastUpdated: new Date().toISOString() },
  { symbol: 'MSFT', price: 425.30, percentChange: -1.2, direction: 'down', lastUpdated: new Date().toISOString() },
  { symbol: 'SPY', price: 595.80, percentChange: 1.8, direction: 'up', lastUpdated: new Date().toISOString() },
];

export default function MonitoredStocksPanel({ selectedStock, onSelectStock, demo = false }) {
  const [stocks, setStocks] = useState([]);
  const [expanded, setExpanded] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newSymbol, setNewSymbol] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [maxSlots, setMaxSlots] = useState(5);
  const [usedSlots, setUsedSlots] = useState(0);

  // Load stocks on mount or when demo prop changes
  useEffect(() => {
    loadMonitoredStocks();
  }, [demo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep quotes fresh: re-poll every 15s while the tab is visible
  useEffect(() => {
    if (demo) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') loadMonitoredStocks();
    };
    const timer = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [demo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore UI state once on mount
  useEffect(() => {
    const savedExpanded = localStorage.getItem('monitoredStocksExpanded');
    if (savedExpanded !== null) {
      setExpanded(JSON.parse(savedExpanded));
    }
    const savedStock = localStorage.getItem('selectedMonitoredStock');
    if (savedStock) {
      onSelectStock(savedStock);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Last good quote per symbol, kept in memory and localStorage so a failed or empty refresh never blanks a price.
  function withLastKnownQuotes(list) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('monitoredStockQuotes')) || {}; } catch { saved = {}; }
    const merged = list.map((stock) => {
      if (stock.price !== null && stock.price !== undefined) {
        saved[stock.symbol] = { price: stock.price, percentChange: stock.percentChange, direction: stock.direction, lastUpdated: stock.lastUpdated };
        return stock;
      }
      const old = saved[stock.symbol];
      return old ? { ...stock, ...old, stale: true } : stock;
    });
    try { localStorage.setItem('monitoredStockQuotes', JSON.stringify(saved)); } catch { /* storage unavailable */ }
    return merged;
  }

  function cachedSymbols() {
    try {
      const saved = JSON.parse(localStorage.getItem('monitoredStockQuotes')) || {};
      return Object.keys(saved).map((symbol) => ({ symbol, price: null }));
    } catch { return []; }
  }

  async function loadMonitoredStocks() {
    try {
      setError(null);
      if (demo) {
        // In demo mode, use sample data
        setStocks(DEMO_STOCKS);
        setMaxSlots(5);
        setUsedSlots(DEMO_STOCKS.length);
      } else {
        const response = await fetch('/api/monitored-stocks');
        if (!response.ok) throw new Error('Failed to load stocks');
        const data = await response.json();
        setStocks(withLastKnownQuotes(data.stocks || []));
        setMaxSlots(data.maxSlots || 5);
        setUsedSlots(data.usedSlots || 0);
      }
    } catch (err) {
      setError(err.message);
      console.error('Error loading monitored stocks:', err);
      // Show the last known prices while the next refresh is pending.
      setStocks((current) => (current.length ? current : withLastKnownQuotes(cachedSymbols())));
    }
  }

  function handleExpandToggle() {
    const newState = !expanded;
    setExpanded(newState);
    localStorage.setItem('monitoredStocksExpanded', JSON.stringify(newState));
  }

  function handleSelectStock(symbol) {
    onSelectStock(symbol);
    localStorage.setItem('selectedMonitoredStock', symbol);
  }

  async function handleAddStock(e) {
    e.preventDefault();
    const symbol = newSymbol.trim().toUpperCase();
    if (!symbol) return;

    try {
      setLoading(true);
      setError(null);

      if (demo) {
        // In demo mode, simulate adding a stock
        if (usedSlots >= maxSlots) {
          throw new Error(`Maximum monitored stocks limit (${maxSlots}) reached`);
        }
        if (stocks.some(s => s.symbol === symbol)) {
          throw new Error(`${symbol} is already in your monitored list`);
        }
        const newStock = {
          symbol,
          price: Math.round(Math.random() * 500 * 100) / 100,
          percentChange: (Math.random() - 0.5) * 10,
          direction: Math.random() > 0.5 ? 'up' : 'down',
          lastUpdated: new Date().toISOString(),
          ivHistory: false
        };
        setStocks([newStock, ...stocks]);
        setUsedSlots(usedSlots + 1);
      } else {
        const response = await fetch(`/api/monitored-stocks/${symbol}`, {
          method: 'POST'
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to add stock');
        }

        const data = await response.json();
        setStocks(data.stocks || []);
        setMaxSlots(data.maxSlots || 5);
        setUsedSlots(data.usedSlots || 0);
      }

      setNewSymbol('');
      setShowAddModal(false);
      handleSelectStock(symbol);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveStock(symbol, e) {
    e.stopPropagation();
    try {
      setError(null);

      if (demo) {
        // In demo mode, just update the local state
        setStocks(stocks.filter(s => s.symbol !== symbol));
        setUsedSlots(Math.max(0, usedSlots - 1));
      } else {
        const response = await fetch(`/api/monitored-stocks/${symbol}`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to remove stock');
        }

        const data = await response.json();
        setStocks(data.stocks || []);
        setMaxSlots(data.maxSlots || 5);
        setUsedSlots(data.usedSlots || 0);
      }

      // If removed stock was selected, clear selection
      if (selectedStock === symbol) {
        onSelectStock(null);
        localStorage.removeItem('selectedMonitoredStock');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  const canAddMore = usedSlots < maxSlots;

  return (
    <>
      <div className="monitored-stocks-panel">
        <div className="panel-header" onClick={handleExpandToggle}>
          <button
            className="expand-toggle"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points={expanded ? "6 9 12 15 18 9" : "9 6 15 12 9 18"}></polyline>
            </svg>
          </button>
          <h3>Monitoring Stock</h3>
        </div>

        {expanded && (
          <div className="panel-content">
            {error && <div className="error-message">{error}</div>}

            {stocks.length === 0 ? (
              <p className="empty-state">No stocks monitored yet</p>
            ) : (
              <ul className="stocks-list">
                {stocks.map(stock => (
                  <li
                    key={stock.symbol}
                    className={`stock-item ${selectedStock === stock.symbol ? 'selected' : ''}`}
                    onClick={() => handleSelectStock(stock.symbol)}
                  >
                    <div className="stock-info">
                      <span className="symbol">{stock.symbol}</span>
                      <DataPendingBadge stock={stock} />
                      {stock.price !== null ? (
                        <>
                          <span className="price" style={stock.stale ? { opacity: 0.55 } : undefined} title={stock.stale ? 'Last known price; refreshing' : undefined}>${stock.price.toFixed(2)}</span>
                          <span className={`change ${stock.direction}`}>
                            {stock.direction === 'up' ? '↑' : '↓'}{Math.abs(stock.percentChange).toFixed(2)}%
                          </span>
                        </>
                      ) : (
                        <span className="error-small">—</span>
                      )}
                    </div>
                    <button
                      className="remove-btn"
                      onClick={(e) => handleRemoveStock(stock.symbol, e)}
                      title="Remove"
                      aria-label={`Remove ${stock.symbol}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="panel-footer">
              <span className="slot-info">{usedSlots}/{maxSlots} slots</span>
              {canAddMore ? (
                <button className="add-stock-btn" onClick={() => setShowAddModal(true)}>
                  + Add stock
                </button>
              ) : (
                <span className="limit-reached">Limit reached</span>
              )}
            </div>
          </div>
        )}
      </div>

      {showAddModal && createPortal(
        <div className="monitored-stocks-modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="monitored-stocks-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Add Stock to Monitor</h4>
            <form onSubmit={handleAddStock}>
              {error && <p className="error-message">{error}</p>}
              <input
                type="text"
                placeholder="Enter stock symbol (e.g., AAPL)"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                disabled={loading}
                autoFocus
              />
              <div className="modal-buttons">
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => { setShowAddModal(false); setError(null); }}
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="confirm-btn"
                  disabled={loading || !newSymbol.trim()}
                >
                  {loading ? 'Adding…' : 'Add'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
