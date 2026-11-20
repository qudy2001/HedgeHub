import datetime
import importlib.util
import math
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('app.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_json_sanitizes_nan_and_option_objects(self):
        from tigeropen.quote.domain.option_analysis import OptionAnalysis
        import pandas as pd
        option = OptionAnalysis()
        option.implied_vol_30_days = .3
        self.assertEqual(bridge.serializable(option)['implied_vol_30_days'], .3)
        self.assertEqual(bridge.serializable(pd.DataFrame([{'value': math.nan}]))[0]['value'], None)
        self.assertEqual(bridge.serializable(datetime.date(2026, 10, 1)), '2026-10-01')

    def test_read_only_routes_use_installed_sdk_fields(self):
        from tigeropen.quote.quote_client import QuoteClient
        with patch.object(bridge, 'call', return_value=[]) as call:
            for endpoint in ['/quotes', '/bars', '/options/expirations', '/options/analysis', '/fundamentals', '/financials', '/valuation', '/flow', '/events', '/dividends']:
                bridge.route(endpoint, {'symbol': ['AAPL']})
            for invocation in call.call_args_list:
                method = invocation.args[0]
                self.assertTrue(hasattr(QuoteClient, method), method)
                self.assertNotIn('order', method)
        with self.assertRaises(ValueError):
            bridge.route('/quotes', {'symbol': ['../../private']})

    def test_stock_volume_periods_and_old_minute_date_queries(self):
        from tigeropen.common.consts import QuoteRight, TradingSession, BarPeriod
        today = datetime.datetime.now(datetime.timezone.utc).date()
        date = (today - datetime.timedelta(days=180)).isoformat()
        with patch.object(bridge, 'call', return_value=[]) as call:
            bridge.route('/stock-volume/bars', {'symbol':['AAPL'], 'period':['1min'], 'from':[date], 'to':[date]})
            self.assertEqual(call.call_args.kwargs['date'], date.replace('-', ''))
            self.assertNotIn('begin_time', call.call_args.kwargs)
            self.assertEqual(call.call_args.kwargs['right'], QuoteRight.NR)
            self.assertEqual(call.call_args.kwargs['trade_session'], TradingSession.Regular)
            for period, expected in [('15min',BarPeriod.FIFTEEN_MINUTES),('30min',BarPeriod.HALF_HOUR),('60min',BarPeriod.ONE_HOUR),('4hour',BarPeriod.FOUR_HOURS),('day',BarPeriod.DAY)]:
                bridge.route('/stock-volume/bars', {'symbol':['AAPL'],'period':[period],'from':[date],'to':[date]})
                self.assertEqual(call.call_args.kwargs['period'], expected)
                self.assertEqual(call.call_args.kwargs['limit'], 1200)
                self.assertNotIn('date', call.call_args.kwargs)
        with self.assertRaises(ValueError):
            bridge.route('/stock-volume/bars', {'symbol':['AAPL'],'period':['invalid'],'from':[date],'to':[date]})
        with self.assertRaises(ValueError):
            bridge.route('/stock-volume/bars', {'symbol':['AAPL'],'period':['1min'],'from':[date],'to':[today.isoformat()]})

    def test_rate_limit_rejects_without_invoking_sdk(self):
        import time
        bridge._calls['get_quote_permission'].clear()
        bridge._calls['get_quote_permission'].extend([time.monotonic()] * 8)
        with self.assertRaises(BlockingIOError):
            bridge.call('get_quote_permission')


if __name__ == '__main__':
    unittest.main()
