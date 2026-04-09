import EventEmitter from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const IB = require("ib");

function normalizeHost(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function normalizeAccountId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function isPaperAccountId(value) {
  const accountId = normalizeAccountId(value);
  return accountId.startsWith("D");
}

function greatestCommonDivisor(values) {
  const integers = (values ?? [])
    .map((value) => Math.max(Math.round(Number(value) || 0), 0))
    .filter(Boolean);

  if (!integers.length) {
    return 1;
  }

  function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
  }

  return integers.reduce((current, value) => gcd(current, value), integers[0]);
}

function normalizeTwsTimestamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})[\s-]+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    return "";
  }

  const [, year, month, day, hour, minute, second = "00"] = match;
  const localIso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const date = new Date(localIso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatExecutionsFilterTime(timestampIso) {
  if (!timestampIso) {
    return "";
  }

  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}:${minute}:${second}`;
}

function normalizeOptionType(value) {
  return String(value ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
}

function normalizeOrderType(value) {
  return String(value ?? "LMT").trim().toUpperCase() === "MKT" ? "MKT" : "LMT";
}

function normalizeTif(value) {
  return String(value ?? "DAY").trim().toUpperCase() === "GTC" ? "GTC" : "DAY";
}

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeTwsOrderStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isTwsFilledStatus(value) {
  return normalizeTwsOrderStatus(value) === "filled";
}

function isTwsCancelledStatus(value) {
  const normalized = normalizeTwsOrderStatus(value);
  return normalized === "cancelled" || normalized === "apicancelled" || normalized === "api_cancelled";
}

function createPaperOrderRef({ paperOrderId, purpose, strategyId }) {
  const normalizedPurpose = String(purpose ?? "entry").trim().toLowerCase() === "exit" ? "exit" : "entry";
  const normalizedStrategyId = String(strategyId ?? "").trim() || "strategy";
  const timestamp = Date.now();
  return `hedgehub:${paperOrderId}:${normalizedPurpose}:${normalizedStrategyId}:${timestamp}`;
}

function parsePaperOrderRef(orderRef) {
  const raw = String(orderRef ?? "").trim();
  if (!raw.startsWith("hedgehub:")) {
    return null;
  }

  const parts = raw.split(":");
  if (parts.length < 5) {
    return null;
  }

  const paperOrderId = Number(parts[1]);
  const purpose = parts[2] === "exit" ? "exit" : "entry";
  const strategyId = parts[3] || "";
  return Number.isInteger(paperOrderId) && paperOrderId > 0 ? { paperOrderId, purpose, strategyId } : null;
}

function buildOptionContractKey(leg) {
  return [
    String(leg?.rootSymbol ?? "").trim().toUpperCase(),
    String(leg?.expiry ?? "").trim(),
    normalizeOptionType(leg?.optionType),
    String(leg?.strike ?? "").trim(),
    String(leg?.contractMultiplier ?? "").trim()
  ]
    .filter(Boolean)
    .join("|");
}

export class TwsPaperApi extends EventEmitter {
  constructor({ clientId = 107 } = {}) {
    super();
    this.clientId = Math.max(Math.round(Number(clientId) || 107), 0);
    this.ib = null;
    this.nextOrderId = null;
    this.reqId = 1;
    this.contractCache = new Map();
    this.orderMetaByOrderId = new Map();
    this.orderRefByOrderId = new Map();
    this.execSeen = new Set();
    this.execByOrderId = new Map();

    this.status = {
      configured: false,
      host: "",
      port: null,
      clientId: this.clientId,
      connected: false,
      authenticated: false,
      ready: false,
      isPaper: false,
      selectedAccount: "",
      accounts: [],
      error: "",
      updatedAt: null
    };
  }

  setStatus(patch = {}) {
    const nextStatus = {
      ...this.status,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    const changed = JSON.stringify(nextStatus) !== JSON.stringify(this.status);
    this.status = nextStatus;
    if (changed) {
      this.emit("status", this.getStatus());
    }
  }

  getStatus() {
    return { ...this.status };
  }

  isReady() {
    return this.status.connected === true && this.status.ready === true;
  }

  disconnect() {
    if (this.ib) {
      try {
        this.ib.removeAllListeners();
        this.ib.disconnect();
      } catch (_error) {
        // noop
      }
    }

    this.ib = null;
    this.nextOrderId = null;
    this.orderMetaByOrderId = new Map();
    this.orderRefByOrderId = new Map();
    this.execSeen = new Set();
    this.execByOrderId = new Map();

    this.setStatus({
      connected: false,
      authenticated: false,
      ready: false
    });
  }

  async connect({ host, port } = {}) {
    const normalizedHost = normalizeHost(host);
    const normalizedPort = normalizePort(port);

    if (!normalizedHost || !normalizedPort) {
      throw new Error("TWS host and port are required");
    }

    if (
      this.ib &&
      this.status.connected === true &&
      this.status.host === normalizedHost &&
      Number(this.status.port ?? 0) === normalizedPort
    ) {
      return this.getStatus();
    }

    this.disconnect();
    this.setStatus({
      configured: true,
      host: normalizedHost,
      port: normalizedPort,
      clientId: this.clientId,
      error: ""
    });

    const ib = new IB({
      clientId: this.clientId,
      host: normalizedHost,
      port: normalizedPort
    });
    this.ib = ib;

    ib.on("connected", () => {
      this.setStatus({
        connected: true,
        authenticated: true,
        error: ""
      });
      try {
        ib.reqIds(1);
        ib.reqManagedAccts();
        ib.reqAllOpenOrders();
      } catch (_error) {
        // ignore
      }
    });

    ib.on("disconnected", () => {
      this.setStatus({
        connected: false,
        authenticated: false,
        ready: false
      });
    });

    ib.on("error", (err, data) => {
      const message = String(err?.message ?? err ?? "").trim();
      const details =
        data && typeof data === "object"
          ? [data.errorCode, data.errorMsg].filter(Boolean).join(" ")
          : "";
      const combined = [message, details].filter(Boolean).join(" ").trim();
      if (combined) {
        this.setStatus({
          error: combined
        });
      }
    });

    ib.on("nextValidId", (orderId) => {
      if (Number.isInteger(orderId) && orderId > 0) {
        this.nextOrderId = orderId;
        this.setStatus({
          ready: Boolean(this.nextOrderId) && Boolean(this.status.selectedAccount)
        });
      }
    });

    ib.on("managedAccounts", (accountsList) => {
      const accounts = String(accountsList ?? "")
        .split(",")
        .map((item) => normalizeAccountId(item))
        .filter(Boolean);
      const selectedAccount = accounts[0] ?? "";
      this.setStatus({
        accounts,
        selectedAccount,
        isPaper: selectedAccount ? isPaperAccountId(selectedAccount) : false,
        ready: Boolean(this.nextOrderId) && Boolean(selectedAccount)
      });
    });

    ib.on("openOrder", (orderId, _contract, order) => {
      const orderRef = String(order?.orderRef ?? "").trim();
      if (orderRef) {
        this.orderRefByOrderId.set(Number(orderId), orderRef);
      }
    });

    ib.on("orderStatus", (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld) => {
      const numericOrderId = Number(orderId);
      const orderRef =
        this.orderRefByOrderId.get(numericOrderId) ??
        (this.orderMetaByOrderId.get(numericOrderId)?.orderRef ?? "");
      const parsedRef = parsePaperOrderRef(orderRef);
      const eventPayload = {
        orderId: numericOrderId,
        status,
        filled,
        remaining,
        avgFillPrice,
        permId,
        parentId,
        lastFillPrice,
        clientId,
        whyHeld,
        orderRef,
        parsedRef,
        normalizedStatus: normalizeTwsOrderStatus(status),
        filledAt: isTwsFilledStatus(status) ? new Date().toISOString() : "",
        cancelledAt: isTwsCancelledStatus(status) ? new Date().toISOString() : ""
      };
      this.emit("orderStatus", eventPayload);
    });

    ib.on("execDetails", (_reqId, contract, exec) => {
      const execId = String(exec?.execId ?? "").trim();
      const orderId = Number(exec?.orderId ?? 0);
      if (!execId || !Number.isInteger(orderId) || orderId <= 0) {
        return;
      }

      const seenKey = `${orderId}:${execId}`;
      if (this.execSeen.has(seenKey)) {
        return;
      }

      this.execSeen.add(seenKey);
      const bucket = this.execByOrderId.get(orderId) ?? [];
      bucket.push({
        orderId,
        execId,
        permId: exec?.permId ?? null,
        orderRef: String(exec?.orderRef ?? "").trim(),
        time: normalizeTwsTimestamp(exec?.time ?? ""),
        side: String(exec?.side ?? "").trim().toUpperCase(),
        shares: toNumber(exec?.shares, 0) ?? 0,
        price: toNumber(exec?.price, 0) ?? 0,
        contract: {
          conId: String(contract?.conId ?? "").trim(),
          localSymbol: String(contract?.localSymbol ?? "").trim(),
          symbol: String(contract?.symbol ?? "").trim(),
          secType: String(contract?.secType ?? "").trim(),
          expiry: String(contract?.expiry ?? "").trim(),
          strike: toNumber(contract?.strike, null),
          right: String(contract?.right ?? "").trim(),
          exchange: String(contract?.exchange ?? "").trim(),
          currency: String(contract?.currency ?? "").trim(),
          multiplier: String(contract?.multiplier ?? "").trim(),
          tradingClass: String(contract?.tradingClass ?? "").trim()
        }
      });
      this.execByOrderId.set(orderId, bucket);

      this.emit("execution", {
        orderId,
        execId,
        orderRef: String(exec?.orderRef ?? "").trim(),
        time: normalizeTwsTimestamp(exec?.time ?? ""),
        side: String(exec?.side ?? "").trim().toUpperCase(),
        shares: toNumber(exec?.shares, 0) ?? 0,
        price: toNumber(exec?.price, 0) ?? 0,
        conId: String(contract?.conId ?? "").trim(),
        localSymbol: String(contract?.localSymbol ?? "").trim()
      });
    });

    ib.connect();

    const readyDeadlineMs = Date.now() + 10_000;

    while (Date.now() < readyDeadlineMs) {
      if (this.isReady()) {
        return this.getStatus();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.getStatus();
  }

  getTradesForOrder(orderId) {
    const numericOrderId = Number(orderId);
    return Array.isArray(this.execByOrderId.get(numericOrderId)) ? [...this.execByOrderId.get(numericOrderId)] : [];
  }

  async requestAllOpenOrders() {
    if (!this.ib || !this.status.connected) {
      throw new Error("TWS is not connected");
    }

    return new Promise((resolve) => {
      const handler = () => {
        this.ib.off("openOrderEnd", handler);
        resolve(true);
      };

      this.ib.on("openOrderEnd", handler);
      try {
        this.ib.reqAllOpenOrders();
      } catch (_error) {
        this.ib.off("openOrderEnd", handler);
        resolve(false);
      }
    });
  }

  async resolveOptionContract(leg) {
    if (!this.ib || !this.status.connected) {
      throw new Error("TWS is not connected");
    }

    const key = buildOptionContractKey(leg);
    if (this.contractCache.has(key)) {
      return this.contractCache.get(key);
    }

    const rootSymbol = String(leg?.rootSymbol ?? "").trim().toUpperCase();
    const expiryIso = String(leg?.expiry ?? "").trim();
    const expiry = expiryIso ? expiryIso.replace(/-/g, "") : "";
    const strike = toNumber(leg?.strike, null);
    const optionType = normalizeOptionType(leg?.optionType);
    const right = optionType === "put" ? "P" : "C";
    const multiplier = Math.max(Math.round(toNumber(leg?.contractMultiplier, 100) ?? 100), 1);

    if (!rootSymbol || !expiry || strike == null) {
      throw new Error("Option leg is missing rootSymbol/expiry/strike for TWS contract resolution");
    }

    const contract = this.ib.contract.option(rootSymbol, expiry, Number(strike), right, "SMART", "USD");
    contract.multiplier = String(multiplier);

    const reqId = this.reqId++;
    const candidates = [];

    const details = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`TWS contract lookup timed out for ${rootSymbol} ${expiry} ${right} ${strike}`));
      }, 7000);

      const onDetails = (incomingReqId, contractDetails) => {
        if (Number(incomingReqId) !== reqId) {
          return;
        }
        candidates.push(contractDetails);
      };

      const onEnd = (incomingReqId) => {
        if (Number(incomingReqId) !== reqId) {
          return;
        }
        cleanup();
        resolve(candidates);
      };

      const onError = (err, data) => {
        if (Number(data?.id ?? -1) !== reqId) {
          return;
        }
        cleanup();
        reject(new Error(String(err?.message ?? data?.errorMsg ?? "TWS contract lookup failed")));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("contractDetails", onDetails);
        this.ib.off("contractDetailsEnd", onEnd);
        this.ib.off("error", onError);
      };

      this.ib.on("contractDetails", onDetails);
      this.ib.on("contractDetailsEnd", onEnd);
      this.ib.on("error", onError);

      try {
        this.ib.reqContractDetails(reqId, contract);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    const best = details.find((item) => item?.summary?.conId) ?? details[0] ?? null;
    const conId = String(best?.summary?.conId ?? "").trim();
    const localSymbol = String(best?.summary?.localSymbol ?? "").trim();
    const exchange = String(best?.summary?.exchange ?? "SMART").trim() || "SMART";
    const currency = String(best?.summary?.currency ?? "USD").trim().toUpperCase() || "USD";

    if (!conId) {
      throw new Error(`TWS did not return a conId for ${rootSymbol} ${expiry} ${right} ${strike}`);
    }

    const resolved = {
      conId,
      localSymbol,
      exchange,
      currency,
      multiplier,
      rootSymbol
    };
    this.contractCache.set(key, resolved);
    return resolved;
  }

  buildRequestedOptionLegs(order, purpose = "entry") {
    const normalizedPurpose = String(purpose ?? "entry").trim().toLowerCase() === "exit" ? "exit" : "entry";

    if (normalizedPurpose !== "entry") {
      return (order?.legs ?? [])
        .filter((leg) => leg?.kind === "option" && Number(leg.quantity ?? 0) > 0)
        .map((leg) => ({
          legId: String(leg.id),
          label: String(leg.label ?? leg.id ?? "Option"),
          rootSymbol: String(leg.rootSymbol ?? order?.marketContext?.proxySymbol ?? "").trim(),
          contractSymbol: String(leg.contractSymbol ?? "").trim(),
          optionType: normalizeOptionType(leg.optionType),
          action: String(leg.action ?? "LONG").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG",
          expiry: String(leg.expiry ?? "").trim(),
          strike: Number(leg.strike ?? 0) || 0,
          requestedQuantity: Math.max(Number(leg.quantity ?? 0) || 0, 0),
          entryPrice: Number(leg.currentPrice ?? leg.entryPrice ?? 0) || 0,
          contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
          brokerConid: String(leg.brokerConid ?? "").trim(),
          ratio: 1
        }));
    }

    const requestedLegsInput =
      Array.isArray(order?.execution?.requestedLegs) && order.execution.requestedLegs.length
        ? order.execution.requestedLegs
        : (order?.legs ?? [])
            .filter((leg) => leg?.kind === "option")
            .map((leg) => ({
              legId: String(leg.id),
              label: String(leg.label ?? leg.id ?? "Option"),
              rootSymbol: String(leg.rootSymbol ?? order?.marketContext?.proxySymbol ?? "").trim(),
              contractSymbol: String(leg.contractSymbol ?? "").trim(),
              optionType: normalizeOptionType(leg.optionType),
              action: String(leg.action ?? "LONG").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG",
              expiry: String(leg.expiry ?? "").trim(),
              strike: Number(leg.strike ?? 0) || 0,
              requestedQuantity: Math.max(Number(leg.quantity ?? 0) || 0, 0),
              entryPrice: Number(leg.entryPrice ?? 0) || 0,
              contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
              brokerConid: String(leg.brokerConid ?? "").trim()
            }));

    const requestedLegs = requestedLegsInput.map((leg) => ({
      legId: String(leg?.legId ?? leg?.id ?? ""),
      label: String(leg?.label ?? leg?.legId ?? leg?.id ?? "Option"),
      rootSymbol: String(leg?.rootSymbol ?? order?.marketContext?.proxySymbol ?? "").trim(),
      contractSymbol: String(leg?.contractSymbol ?? "").trim(),
      optionType: normalizeOptionType(leg?.optionType),
      action: String(leg?.action ?? "LONG").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG",
      expiry: String(leg?.expiry ?? "").trim(),
      strike: Number(leg?.strike ?? 0) || 0,
      requestedQuantity: Math.max(Number(leg?.requestedQuantity ?? leg?.quantity ?? 0) || 0, 0),
      entryPrice: Number(leg?.entryPrice ?? 0) || 0,
      contractMultiplier: Math.max(Number(leg?.contractMultiplier ?? 100) || 100, 1),
      brokerConid: String(leg?.brokerConid ?? "").trim()
    }));

    const gcdQuantity = greatestCommonDivisor(
      requestedLegs.map((leg) => Math.max(Math.round(Number(leg.requestedQuantity ?? 0) || 0), 0)).filter(Boolean)
    );

    return requestedLegs.map((leg) => ({
      ...leg,
      ratio: Math.max(Math.round(Number(leg.requestedQuantity ?? 0) || 0), 0) / gcdQuantity || 1
    }));
  }

  inferComboEntryAction(requestedLegs) {
    const netDebit = requestedLegs.reduce((sum, leg) => {
      const ratio = Number(leg.ratio ?? 1) || 1;
      const price = Number(leg.entryPrice ?? 0) || 0;
      const signedPrice = leg.action === "SHORT" ? -price : price;
      return sum + signedPrice * ratio;
    }, 0);

    return netDebit < 0 ? "SELL" : "BUY";
  }

  async submitOptionOrder({ order, purpose = "entry" }) {
    if (!this.ib || !this.status.connected) {
      throw new Error("TWS is not connected");
    }

    if (this.status.isPaper !== true) {
      throw new Error("TWS must be logged into a paper account (starts with D/DU) for HedgeHub paper routing.");
    }

    if (!Number.isInteger(this.nextOrderId) || this.nextOrderId <= 0) {
      throw new Error("TWS is connected but not ready (missing nextValidId)");
    }

    const normalizedPurpose = String(purpose ?? "entry").trim().toLowerCase() === "exit" ? "exit" : "entry";
    const requestedLegs = this.buildRequestedOptionLegs(order, normalizedPurpose).filter(
      (leg) => Number(leg.requestedQuantity ?? 0) > 0
    );

    if (!requestedLegs.length) {
      throw new Error("No option legs are available to route through TWS");
    }

    const resolvedLegs = [];

    for (const leg of requestedLegs) {
      const resolved =
        leg.brokerConid && /^\d+$/.test(String(leg.brokerConid))
          ? {
              conId: String(leg.brokerConid),
              localSymbol: String(leg.contractSymbol ?? "").trim(),
              exchange: "SMART",
              currency: "USD",
              multiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
              rootSymbol: String(leg.rootSymbol ?? "").trim().toUpperCase()
            }
          : await this.resolveOptionContract(leg);

      resolvedLegs.push({
        ...leg,
        brokerConid: String(resolved.conId),
        localSymbol: resolved.localSymbol,
        exchange: resolved.exchange,
        currency: resolved.currency,
        contractMultiplier: resolved.multiplier
      });
    }

    const isCombo = resolvedLegs.length > 1;
    const orderQuantity = isCombo
      ? greatestCommonDivisor(
          resolvedLegs.map((leg) => Math.max(Math.round(Number(leg.requestedQuantity ?? 0) || 0), 0)).filter(Boolean)
        )
      : Math.max(Math.round(Number(resolvedLegs[0]?.requestedQuantity ?? 0) || 0), 0);

    if (!(orderQuantity > 0)) {
      throw new Error("TWS order quantity must be greater than zero");
    }

    const orderType = normalizeOrderType(order?.execution?.orderType);
    const tif = normalizeTif(order?.execution?.tif);
    const outsideRth = order?.execution?.outsideRth === true;
    const limitPrice = orderType === "LMT" ? toNumber(order?.execution?.limitPrice, null) : null;

    if (orderType === "LMT" && limitPrice == null) {
      throw new Error("TWS limit orders require a limit price");
    }

    if (orderType === "LMT" && !isCombo && limitPrice != null && limitPrice < 0) {
      throw new Error("TWS single-leg limit orders require a non-negative limit price");
    }

    const orderRef = createPaperOrderRef({
      paperOrderId: Number(order.id),
      purpose: normalizedPurpose,
      strategyId: order?.strategyId ?? order?.strategy_id ?? order?.strategyName ?? "strategy"
    });

    const orderId = this.nextOrderId;
    this.nextOrderId += 1;
    this.orderMetaByOrderId.set(orderId, {
      paperOrderId: Number(order.id),
      purpose: normalizedPurpose,
      orderRef
    });
    this.orderRefByOrderId.set(orderId, orderRef);

    const contract = isCombo
      ? (() => {
          const rootSymbol = String(resolvedLegs[0]?.rootSymbol ?? "").trim().toUpperCase();
          const combo = this.ib.contract.combo(rootSymbol, "USD", "SMART");
          combo.comboLegs = resolvedLegs.map((leg) => ({
            conId: Number(leg.brokerConid),
            ratio: Math.max(Number(leg.ratio ?? 1) || 1, 1),
            action: String(leg.action ?? "LONG").toUpperCase() === "SHORT" ? "SELL" : "BUY",
            exchange: "SMART",
            openClose: 0,
            shortSaleSlot: 0,
            designatedLocation: "",
            exemptCode: -1
          }));
          return combo;
        })()
      : (() => {
          const leg = resolvedLegs[0];
          const expiry = String(leg.expiry ?? "").trim().replace(/-/g, "");
          const right = normalizeOptionType(leg.optionType) === "put" ? "P" : "C";
          const opt = this.ib.contract.option(
            String(leg.rootSymbol ?? "").trim().toUpperCase(),
            expiry,
            Number(leg.strike ?? 0) || 0,
            right,
            "SMART",
            "USD"
          );
          opt.conId = Number(leg.brokerConid);
          opt.localSymbol = String(leg.localSymbol ?? "").trim();
          opt.multiplier = String(leg.contractMultiplier ?? "100");
          return opt;
        })();

    const action = isCombo
      ? normalizedPurpose === "exit"
        ? "SELL"
        : "BUY"
      : (() => {
          const legIsShort = String(resolvedLegs[0]?.action ?? "LONG").toUpperCase() === "SHORT";
          if (normalizedPurpose === "exit") {
            return legIsShort ? "BUY" : "SELL";
          }
          return legIsShort ? "SELL" : "BUY";
        })();
    const baseOrder =
      orderType === "LMT"
        ? this.ib.order.limit(action, orderQuantity, Number(limitPrice), true)
        : this.ib.order.market(action, orderQuantity, true);
    baseOrder.tif = tif;
    baseOrder.outsideRth = outsideRth;
    baseOrder.orderRef = orderRef;
    baseOrder.account = this.status.selectedAccount || undefined;

    this.ib.placeOrder(orderId, contract, baseOrder);

    const submittedAt = new Date().toISOString();

    return {
      accountId: this.status.selectedAccount,
      accountAlias: "",
      isPaper: this.status.isPaper === true,
      status: "submitted",
      statusText: "Submitted",
      statusDescription: "",
      brokerOrderId: String(orderId),
      orderRef,
      orderType,
      tif,
      outsideRth,
      limitPrice,
      avgFillPrice: null,
      combo: isCombo,
      purpose: normalizedPurpose,
      totalQuantity: orderQuantity,
      filledQuantity: 0,
      remainingQuantity: orderQuantity,
      submittedAt,
      lastSyncAt: submittedAt,
      filledAt: "",
      cancelledAt: "",
      lastError: "",
      lastWarning: "",
      warningMessages: [],
      pendingReplyId: "",
      pendingReplyMessages: [],
      requestedLegs: resolvedLegs.map((leg) => ({
        legId: leg.legId,
        label: leg.label,
        rootSymbol: leg.rootSymbol,
        contractSymbol: leg.contractSymbol,
        optionType: normalizeOptionType(leg.optionType),
        action: leg.action,
        expiry: leg.expiry,
        strike: leg.strike,
        requestedQuantity: Math.max(Number(leg.requestedQuantity ?? 0) || 0, 0),
        ratio: Number(leg.ratio ?? 1) || 1,
        entryPrice: Number(leg.entryPrice ?? 0) || 0,
        contractMultiplier: Math.max(Number(leg.contractMultiplier ?? 100) || 100, 1),
        brokerConid: String(leg.brokerConid),
        localSymbol: String(leg.localSymbol ?? "")
      }))
    };
  }

  async fetchExecutions({ since = null } = {}) {
    if (!this.ib || !this.status.connected) {
      throw new Error("TWS is not connected");
    }

    const reqId = this.reqId++;
    const executions = [];
    const sinceFilter = since ? formatExecutionsFilterTime(since) : "";

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(executions);
      }, 7000);

      const onExec = (incomingReqId, contract, exec) => {
        if (Number(incomingReqId) !== reqId) {
          return;
        }
        executions.push({
          contract,
          exec,
          time: normalizeTwsTimestamp(exec?.time ?? "")
        });
      };

      const onEnd = (incomingReqId) => {
        if (Number(incomingReqId) !== reqId) {
          return;
        }
        cleanup();
        resolve(executions);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("execDetails", onExec);
        this.ib.off("execDetailsEnd", onEnd);
      };

      this.ib.on("execDetails", onExec);
      this.ib.on("execDetailsEnd", onEnd);

      try {
        this.ib.reqExecutions(reqId, {
          clientId: 0,
          acctCode: this.status.selectedAccount || "",
          time: sinceFilter,
          symbol: "",
          secType: "",
          exchange: "",
          side: ""
        });
      } catch (_error) {
        cleanup();
        resolve(executions);
      }
    });
  }
}

export const twsPaperApi = new TwsPaperApi();

export function parseTwsPaperOrderRef(orderRef) {
  return parsePaperOrderRef(orderRef);
}
