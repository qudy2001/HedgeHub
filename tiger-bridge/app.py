"""Private, read-only Tiger market-data bridge. No trading client or order endpoints."""
import collections
import datetime as dt
import hmac
import json
import math
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

_client = None
_lock = threading.RLock()
_calls = collections.defaultdict(collections.deque)


def serializable(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): serializable(v) for k, v in value.items() if not str(k).startswith('_')}
    if isinstance(value, (list, tuple)):
        return [serializable(v) for v in value]
    if hasattr(value, 'to_dict'):
        try:
            return serializable(value.to_dict(orient='records'))
        except TypeError:
            return serializable(value.to_dict())
    if hasattr(value, 'item'):
        return serializable(value.item())
    if hasattr(value, '__dict__'):
        return serializable(vars(value))
    return str(value)


def client():
    global _client
    if _client is None:
        folder = os.environ.get('TIGER_CONFIG_DIR')
        if not folder:
            raise ValueError('Tiger credentials are not configured')
        from tigeropen.tiger_open_config import TigerOpenClientConfig
        from tigeropen.quote.quote_client import QuoteClient
        # Explicitly opt in to owning the device; never claim it on each request.
        _client = QuoteClient(TigerOpenClientConfig(props_path=folder),
                              is_grab_permission=os.getenv('TIGER_CLAIM_DEVICE') == 'true')
    return _client


def call(name, *args, **kwargs):
    with _lock:
        now = time.monotonic()
        q = _calls[name]
        while q and q[0] < now - 60:
            q.popleft()
        # Leave headroom for another consumer; one owner is recommended.
        limit = 8 if name in ('get_quote_permission', 'get_kline_quota', 'get_market_status') else 45
        if len(q) >= limit:
            raise BlockingIOError('Provider rate limit: retry after 60 seconds')
        q.append(now)
        return serializable(getattr(client(), name)(*args, **kwargs))


def route(path, query):
    from tigeropen.common.consts import Market, BarPeriod, OptionAnalysisPeriod, CapitalPeriod, FinancialReportPeriodType
    from tigeropen.common.consts import Income, CashFlow, Balance, Valuation
    symbol = query.get('symbol', [''])[0].upper()
    if path not in ('/health', '/permissions', '/session') and (not symbol or len(symbol) > 16 or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-' for c in symbol)):
        raise ValueError('Invalid symbol')
    today = dt.datetime.now(dt.timezone.utc).date()
    if path == '/health':
        return {'configured': bool(os.getenv('TIGER_CONFIG_DIR')), 'sdk': '3.8.0', 'readOnly': True}
    if path == '/permissions':
        return {'permissions': call('get_quote_permission'), 'quota': call('get_kline_quota')}
    if path == '/session':
        return call('get_market_status', Market.US)
    if path == '/quotes':
        return call('get_stock_briefs', [symbol])
    if path == '/bars':
        return call('get_bars', [symbol], period=BarPeriod.DAY, limit=1200)
    if path == '/stock-volume/bars':
        from tigeropen.common.consts import QuoteRight, TradingSession
        periods = {'1min': BarPeriod.ONE_MINUTE, '15min': BarPeriod.FIFTEEN_MINUTES,
                   '30min': BarPeriod.HALF_HOUR, '60min': BarPeriod.ONE_HOUR,
                   '4hour': BarPeriod.FOUR_HOURS, 'day': BarPeriod.DAY}
        period = query.get('period', ['60min'])[0]
        if period not in periods:
            raise ValueError('Unsupported stock bar interval')
        begin = dt.date.fromisoformat(query.get('from', [''])[0])
        end = dt.date.fromisoformat(query.get('to', [''])[0])
        if begin > end or end > today or (today - begin).days > 370 or (end - begin).days > 31:
            raise ValueError('Invalid stock bar window')
        kwargs = {'period': periods[period], 'right': QuoteRight.NR,
                  'trade_session': TradingSession.Regular, 'limit': 1200}
        if period == '1min':
            if begin != end:
                raise ValueError('Minute history requires a single date')
            # SDK 3.8.0 date queries can retrieve older minute data without the
            # recent-month restriction of begin_time/end_time range queries.
            kwargs['date'] = begin.strftime('%Y%m%d')
        else:
            kwargs['begin_time'] = int(dt.datetime.combine(begin, dt.time(), dt.timezone.utc).timestamp() * 1000)
            kwargs['end_time'] = int(dt.datetime.combine(end + dt.timedelta(days=1), dt.time(), dt.timezone.utc).timestamp() * 1000) - 1
        return call('get_bars', [symbol], **kwargs)
    if path == '/options/expirations':
        return call('get_option_expirations', [symbol], market=Market.US)
    if path == '/options/chain':
        expiry = query.get('expiry', [''])[0]
        dt.date.fromisoformat(expiry)
        return call('get_option_chain', symbol, expiry, market=Market.US)
    if path == '/options/depth':
        identifiers = query.get('contract', [])[:30]
        if not identifiers:
            raise ValueError('contract required')
        return call('get_option_depth', identifiers, market=Market.US)
    if path == '/options/analysis':
        return call('get_option_analysis', [symbol], period=OptionAnalysisPeriod.FIFTY_TWO_WEEK,
                    market=Market.US, require_volatility_list=True)
    if path == '/flow':
        return {'history': call('get_capital_flow', symbol, market=Market.US, period=CapitalPeriod.DAY, limit=260),
                'distribution': call('get_capital_distribution', symbol, market=Market.US)}
    if path == '/fundamentals':
        return call('get_stock_fundamental', [symbol], Market.US)
    if path == '/financials':
        return call('get_financial_report', [symbol], Market.US,
                    fields=[Income.total_revenue, Income.net_income, CashFlow.cash_from_ops,
                            CashFlow.levered_free_cash_flow, Balance.total_debt,
                            Balance.total_assets, Balance.total_liabilities],
                    period_type=FinancialReportPeriodType.QUARTERLY,
                    begin_date=str(today - dt.timedelta(days=365 * 3)), end_date=str(today))
    if path == '/valuation':
        return call('get_financial_daily', [symbol], Market.US,
                    fields=[Valuation.p_to_ltm_diluted_eps_before_extra, Valuation.market_cap_to_ltm_levered_fcf],
                    begin_date=str(today - dt.timedelta(days=365 * 3)), end_date=str(today))
    if path == '/events':
        # Preserve the response and coverage separately; absence is not confirmation.
        begin = dt.date.fromisoformat(query.get('from', [str(today)])[0])
        end = dt.date.fromisoformat(query.get('to', [str(today + dt.timedelta(days=100))])[0])
        if end < begin or (end - begin).days > 465:
            raise ValueError('Invalid event window')
        return {'earnings': call('get_corporate_earnings_calendar', Market.US, str(begin), str(end)),
                'complete': False, 'from': str(begin), 'to': str(end)}
    if path == '/dividends':
        return call('get_corporate_dividend', [symbol], Market.US, str(today), str(today + dt.timedelta(days=100)))
    raise ValueError('Unknown endpoint')


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        token = os.getenv('TIGER_BRIDGE_TOKEN', '')
        if not token or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
            self.respond(401, {'error': 'Bridge authorization required'})
            return
        url = urlparse(self.path)
        try:
            data = route(url.path, parse_qs(url.query))
            self.respond(200, {'data': data, 'fetchedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
        except BlockingIOError as exc:
            self.respond(429, {'error': str(exc)})
        except ValueError:
            self.respond(400, {'error': 'Invalid request or Tiger configuration missing'})
        except Exception as exc:
            # SDK error text can contain signed request details. Never return/log it.
            self.respond(502, {'error': 'Tiger request failed: check entitlement, device ownership and configuration', 'type': type(exc).__name__})

    def respond(self, code, body):
        payload = json.dumps(body, allow_nan=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        if code == 429:
            self.send_header('Retry-After', '60')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer((os.getenv('TIGER_BRIDGE_HOST', '127.0.0.1'), 8788), Handler).serve_forever()
