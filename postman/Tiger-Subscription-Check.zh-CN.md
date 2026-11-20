# Tiger 订阅权限验证（Postman）

这套 collection 对应当前已实现的 **本地只读 Python SDK bridge**。它不会直接向 Tiger 原生接口发送 HTTP 请求，也不会下单或购买订阅。Tiger SDK 负责认证；Tiger 私钥、账号配置不放进 Postman。

## 1. 启动本地 bridge

在 HedgeHub 项目目录执行一次安装：

```sh
python3 -m venv .venv-tiger
.venv-tiger/bin/pip install -r tiger-bridge/requirements.txt
```

把 Tiger 官方 SDK 配置放在项目外的独立目录。随后在同一个终端设置：

```sh
export TIGER_CONFIG_DIR='/你的/Tiger配置目录'
export TIGER_BRIDGE_TOKEN='替换为你自己的随机长字符串'
.venv-tiger/bin/python tiger-bridge/app.py
```

`TIGER_CONFIG_DIR` 是包含 `tiger_openapi_config.properties` 等官方配置的目录，不是文件名。`TIGER_BRIDGE_TOKEN` 是保护本地 HTTP 服务的自定义口令，不是 Tiger 私钥或 Tiger API token。保持这个终端运行；无需启动完整 HedgeHub 应用。bridge 默认只监听本机 `127.0.0.1:8788`。

默认不抢占行情设备访问权。如果确认失败是设备权限冲突，可以在专门负责行情的这台机器设置 `TIGER_CLAIM_DEVICE=true` 后重启 bridge；这可能影响其他设备的 API 行情访问，不要在多台机器同时开启。

## 2. 导入 Postman

导入同目录下两份文件：

- `Tiger-Subscription-Check.postman_collection.json`
- `Tiger-Subscription-Check.local.postman_environment.json`

选择环境 **HedgeHub · Tiger local subscription check**，设置变量：

| 变量 | 值 |
|---|---|
| `tigerBridgeUrl` | `http://127.0.0.1:8788` |
| `tigerBridgeToken` | 与终端 `TIGER_BRIDGE_TOKEN` 一致，仅填本地值，不共享或导出真实口令 |
| `symbol` | 先用 `AAPL`，不要先用 ETF 测财报 |
| `optionType` | `put` 或 `call` |
| `expiry` | 留空，请求 05 自动填写；也可随后手动选择返回的其他到期日 |
| `contractSymbol` | 留空，请求 06 自动填写 |
| `requireFreshQuotes` | 默认 `false`；美国正常交易时段设成 `true`，额外验证期权双边报价不超过 90 秒 |

使用 Postman 桌面版，或支持访问本机的 Desktop Agent。Collection 继承 Bearer authentication，不需要 HedgeHub 登录 cookie。

## 3. 按编号运行

优先手动按顺序发送 **01–07**，查看响应和 Tests/Post-response 测试结果。05、06 的脚本会填写下一步变量；更换 symbol 后重新从 04、05、06 执行，避免错配合约。

| 请求 | 判断内容 |
|---|---|
| 01 Health | 本地 bridge 可访问、配置目录已设置。通过不代表 Tiger 密钥正确 |
| 02 Permissions | 查看 `data.permissions` 和 `data.quota`；保留权限名称、有效期和额度信息 |
| 03 Session | 确认当前美国市场状态 |
| 04 Stock quote | 股票报价是否能返回；查看时间并与 Tiger App 对比 |
| 05–06 Expirations / Chain | 期权到期日和有效买卖价是否能获取 |
| 07 Depth | HedgeHub 用于核验报价时间戳的盘口接口是否可用 |
| 08 Bars | 历史 K 线和额度是否可用 |
| 09 IV | IV 分析和历史序列是否可用 |
| 10–12 Fundamentals / Financials / Valuation | 基本面、财务报表、历史估值是否有额外权限 |
| 13–15 Events / Dividends / Flow | 额外研究数据的覆盖情况 |

也可以在 Collection Runner 按原顺序运行，单次 iteration、建议请求间隔 1000 ms。不需要循环跑；不要把 200 状态或所有测试通过理解为数据完整、适合交易或所有功能已验证。股票报价时效需人工比对，盘口时效测试仅在启用 `requireFreshQuotes` 时执行。休市后的旧报价不等于缺少订阅。

## 4. 如何决定是否需要买订阅

- 股票和期权报价、盘口均成功，并在交易时段时间戳/报价对得上：对应基础行情先不用重复买。
- 股票成功、期权失败：检查实际 US Options L1 权限、合约参数、设备访问权；不能直接认定免费权限无效。
- 期权链成功、盘口失败：单独确认 `get_option_depth` 的权限和覆盖。不要因此购买 Nasdaq TotalView 或 CBOE Futures L2。
- 财报/估值失败但行情成功：先向 Tiger 申请/确认基本面接口权限，不是升级股票 L2。
- IV 或历史数据失败：检查具体接口权限、标的支持情况和历史额度。

响应排查：

- 连接被拒绝：bridge 没启动、端口不对，或使用了不能访问本机的云端 Agent。
- `401`：本地 bridge token 不匹配。
- `400`：参数不正确或 SDK 配置缺失；检查 05/06 自动变量是否生成。
- `429`：等待至少 60 秒后重试，不要连续点击。
- `502`：Tiger SDK 请求失败，可能是权限、认证、行情设备占用或网络问题。bridge 故意不返回可能包含签名/敏感信息的原始 SDK 错误，因此仅凭 502 不能判断需要买哪项订阅。
- 空的财报日历/分红结果可能是正常情况；空基本面也可能与标的类型有关。

可以提供请求编号、HTTP 状态、脱敏后的权限名称/有效期，以及报价字段和时间戳来继续判断。不要提供私钥、Authorization header、bridge token 或完整账户配置。

此前的 `HedgeHub-TigerTrade.postman_collection.json` 是另一套较早的设计文件，包含当前未实现的 streaming/切换 provider 接口；本次验证使用 **Tiger-Subscription-Check** 这套。
