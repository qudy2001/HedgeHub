import { useState, useEffect } from 'react';
import '../styles/monitored-stocks-grid.css';
import DataPendingBadge from './DataPendingBadge.jsx';

const DEMO_STOCKS = [
  { symbol: 'AAPL', price: 220.45, percentChange: 2.3, direction: 'up', lastUpdated: new Date().toISOString() },
  { symbol: 'MSFT', price: 425.30, percentChange: -1.2, direction: 'down', lastUpdated: new Date().toISOString() },
  { symbol: 'SPY', price: 595.80, percentChange: 1.8, direction: 'up', lastUpdated: new Date().toISOString() },
];

export default function MonitoredStocksTileGrid({ onSelectStock, demo = false }) {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadStocks();
  }, []);

  async function loadStocks() {
    try {
      setLoading(true);
      setError(null);
      if (demo) {
        // In demo mode, use sample data
        setStocks(DEMO_STOCKS);
      } else {
        const response = await fetch('/api/monitored-stocks');
        if (!response.ok) throw new Error('Failed to load stocks');
        const data = await response.json();
        setStocks(data.stocks || []);
      }
    } catch (err) {
      setError(err.message);
      console.error('Error loading stocks:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="monitored-stocks-grid">
        <div className="loading">Loading monitored stocks...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="monitored-stocks-grid">
        <div className="error">{error}</div>
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div className="monitored-stocks-grid">
        <div className="empty">
          <p>No stocks are currently being monitored.</p>
          <p className="hint">Use the sidebar to add stocks to your monitoring list.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="monitored-stocks-grid">
      <div className="grid-container">
        {stocks.map(stock => (
          <div
            key={stock.symbol}
            className="stock-tile"
            onClick={() => onSelectStock(stock.symbol)}
          >
            <div className="tile-header">
              <h3 className="tile-symbol">{stock.symbol}<DataPendingBadge stock={stock} /></h3>
              <div className={`tile-direction ${stock.direction}`}>
                {stock.direction === 'up' ? '↑' : stock.direction === 'down' ? '↓' : '–'}
              </div>
            </div>

            {stock.price !== null ? (
              <>
                <div className="tile-price">${stock.price.toFixed(2)}</div>
                <div className={`tile-change ${stock.direction}`}>
                  {stock.direction === 'up' ? '+' : ''}{stock.percentChange.toFixed(2)}%
                </div>
              </>
            ) : (
              <div className="tile-loading">
                <span>Loading price...</span>
              </div>
            )}

            <button className="view-btn" onClick={(e) => {
              e.stopPropagation();
              onSelectStock(stock.symbol);
            }}>
              View Details →
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
