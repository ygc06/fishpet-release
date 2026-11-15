/**
 * Read-only RMB estimates for one companion turn.
 *
 * The optional dsh-cost-meter service owns the price table and exchange rate.
 * This module only turns the model usage captured by the emotion bridge into a
 * small, stable cost record. Missing usage or a missing price is never treated
 * as a zero-cost call.
 */

const PEER_OFFPEAK_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z');
const DEFAULT_PEAK_WINDOWS = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveTokens(value) {
  const number = finite(value);
  return number === null ? null : Math.max(0, Math.trunc(number));
}

function canonicalModel(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[(（]\s*(?:go|zen)\s*[)）]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizedProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return provider.startsWith('llm-') ? provider.slice(4) : provider;
}

function priceEntry(prices, provider, model) {
  const normalized = normalizedProvider(provider);
  const deepseek = !normalized || normalized.includes('deepseek');
  const table = deepseek
    ? isObject(prices?.models) ? prices.models : null
    : isObject(prices?.providers?.[normalized]?.models)
      ? prices.providers[normalized].models
      : null;
  if (!table) return null;
  if (model && Object.hasOwn(table, model)) return table[model];

  const wanted = canonicalModel(model);
  const matches = wanted
    ? Object.keys(table).filter((id) => canonicalModel(id) === wanted)
    : [];
  if (matches.length === 1) return table[matches[0]];
  return deepseek && isObject(prices?.default) ? prices.default : null;
}

function entryAt(entry, atMs) {
  if (!Array.isArray(entry?.rateHistory) || !entry.rateHistory.length) return entry;
  let chosen = null;
  let boundary = Infinity;
  for (const period of entry.rateHistory) {
    const until = Date.parse(period?.before || '');
    if (Number.isFinite(until) && atMs < until && until < boundary) {
      chosen = period;
      boundary = until;
    }
  }
  if (!chosen) return entry;
  const { before: _before, ...rates } = chosen;
  return { ...entry, ...rates };
}

function chinaDayKey(atMs) {
  const shifted = new Date(atMs + 8 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

function chinaWeekend(atMs) {
  const shifted = new Date(atMs + 8 * 3_600_000);
  return shifted.getUTCDay() === 0 || shifted.getUTCDay() === 6;
}

function inWindow(hour, window) {
  const start = finite(window?.start);
  const end = finite(window?.end);
  if (start === null || end === null) return false;
  return end > start ? hour >= start && hour < end : hour >= start || hour < end;
}

function factor(entry, path, field) {
  return entry?.separateMultipliers
    ? finite(entry?.multipliers?.[`${path}.${field}`]) ?? 1
    : finite(entry?.multiplier) ?? 1;
}

function normalizeTier(price) {
  if (!isObject(price) || price.unpriced === true) return null;
  const input = finite(price.cacheMiss) ?? finite(price.input);
  const cacheHit = finite(price.cacheHit)
    ?? finite(price.cachedInput)
    ?? finite(price.cacheRead)
    ?? input;
  const cacheWrite = finite(price.cacheWrite);
  const output = finite(price.output);
  const reasoning = finite(price.reasoning);
  const hasRate = [input, cacheHit, cacheWrite, output, reasoning].some((value) => value !== null);
  if (!hasRate) return null;
  const tier = {
    cacheMiss: Math.max(0, input ?? 0),
    cacheHit: Math.max(0, cacheHit ?? input ?? 0),
    output: Math.max(0, output ?? 0),
    reasoning: Math.max(0, reasoning ?? 0),
  };
  if (cacheWrite !== null) tier.cacheWrite = Math.max(0, cacheWrite);
  if (isObject(price.longContext)) {
    const threshold = finite(price.longContext.aboveInputTokens);
    const long = normalizeTier(price.longContext);
    if (threshold !== null && long) tier.longContext = { ...long, aboveInputTokens: threshold };
  }
  return tier;
}

function multipliedTier(price, entry, path) {
  const tier = normalizeTier(price);
  if (!tier) return null;
  const out = { ...tier };
  for (const field of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning']) {
    if (finite(out[field]) !== null) out[field] = finite(out[field]) * factor(entry, path, field);
  }
  if (tier.longContext) {
    const long = multipliedTier(tier.longContext, entry, 'longContext');
    if (long) out.longContext = { ...long, aboveInputTokens: tier.longContext.aboveInputTokens };
  }
  return out;
}

function selectedTier(entry, atMs, config) {
  if (!isObject(entry)) return null;
  const peakEnabled = config?.peakEnabled === true;
  const effectiveAtMs = Date.parse(config?.peakEffectiveAt || '');
  const beforeEffective = Number.isFinite(effectiveAtMs) && atMs < effectiveAtMs;
  if (peakEnabled && !beforeEffective) {
    const windows = Array.isArray(config?.peakWindows) && config.peakWindows.length
      ? config.peakWindows
      : DEFAULT_PEAK_WINDOWS;
    const ollama = entry.peakSchedule === 'ollama';
    if (ollama || entry.billingMode === 'utc-peak') {
      const date = new Date(atMs);
      const day = date.getUTCDay();
      const high = day > 0 && day < 6 && (ollama
        ? date.getUTCHours() >= 12 && date.getUTCHours() < 18
        : inWindow(date.getUTCHours(), windows[0]) || inWindow(date.getUTCHours(), windows[1]));
      return multipliedTier(
        high ? entry.peak : entry.offPeak,
        entry,
        high ? 'peak' : 'offPeak',
      ) || multipliedTier(entry, entry, 'base');
    }
    const holidays = Array.isArray(config?.peakHolidays) ? config.peakHolidays : [];
    const offpeakDay = atMs >= PEER_OFFPEAK_EFFECTIVE_AT
      && (chinaWeekend(atMs) || holidays.includes(chinaDayKey(atMs)));
    const high = !offpeakDay && inWindow(new Date(atMs).getUTCHours(), windows[0])
      || !offpeakDay && inWindow(new Date(atMs).getUTCHours(), windows[1]);
    return multipliedTier(
      high ? entry.peak : entry.offPeak,
      entry,
      high ? 'peak' : 'offPeak',
    ) || multipliedTier(entry, entry, 'base');
  }
  return multipliedTier(entry, entry, 'base');
}

function usageNumbers(usage) {
  const source = isObject(usage) ? usage : {};
  const inputTokens = positiveTokens(source.inputTokens ?? source.in ?? source.promptTokens);
  const outputTokens = positiveTokens(source.outputTokens ?? source.out ?? source.completionTokens);
  const cacheReadTokens = positiveTokens(source.cacheReadTokens ?? source.cache_read_tokens);
  const cacheWriteTokens = positiveTokens(source.cacheWriteTokens ?? source.cache_write_tokens);
  const reasoningTokens = positiveTokens(source.reasoningTokens ?? source.reasoning_tokens);
  const totalTokens = positiveTokens(source.totalTokens)
    ?? (
      inputTokens !== null || cacheReadTokens !== null || cacheWriteTokens !== null || outputTokens !== null
        ? (inputTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0) + (outputTokens || 0)
        : null
    );
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}

function hasUsageBreakdown(usage) {
  return [
    usage?.inputTokens,
    usage?.outputTokens,
    usage?.cacheReadTokens,
    usage?.cacheWriteTokens,
    usage?.reasoningTokens,
  ].some((value) => finite(value) !== null);
}

function sumUsage(parts) {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  let seen = false;
  for (const part of parts) {
    for (const key of Object.keys(total)) {
      const value = finite(part?.[key]);
      if (value !== null) {
        total[key] += value;
        seen = true;
      }
    }
  }
  return seen ? total : null;
}

function unavailable(reason, details = {}) {
  return {
    status: 'unavailable',
    estimated: false,
    cost: null,
    currency: 'CNY',
    symbol: '¥',
    source: 'dsh-cost-meter-price',
    reason: String(reason || 'unavailable'),
    ...details,
  };
}

/**
 * Pure estimate against a dsh-cost-meter getState() snapshot.
 *
 * @param {object} options
 * @param {object} options.state cost-meter state/config snapshot.
 * @param {object} options.usage model usage block.
 * @param {string} options.provider provider id.
 * @param {string} options.model model id.
 * @param {number} options.at epoch milliseconds.
 * @returns {object}
 */
export function estimateUsageFromState({ state, usage, provider, model, at }) {
  const usageValue = usageNumbers(usage);
  if (usageValue.totalTokens === null) return unavailable('usage-missing');
  if (!hasUsageBreakdown(usageValue)) {
    return unavailable('usage-breakdown-missing', { usage: usageValue });
  }

  const config = isObject(state?.config) ? state.config : isObject(state) ? state : {};
  const prices = isObject(config.prices) ? config.prices : null;
  if (!prices) {
    return unavailable('price-table-unavailable', {
      usage: usageValue,
      provider: String(provider || ''),
      model: String(model || ''),
    });
  }

  const rawEntry = priceEntry(prices, provider, model);
  if (!isObject(rawEntry) || rawEntry.unpriced === true) {
    return unavailable('price-unavailable', {
      usage: usageValue,
      provider: String(provider || ''),
      model: String(model || ''),
    });
  }

  const atMs = finite(at) ?? Date.now();
  let entry = entryAt(rawEntry, atMs);
  let priceCurrency = (prices.currency || config.pricingCurrency) === 'CNY' ? 'CNY' : 'USD';
  if (priceCurrency === 'CNY' && isObject(entry.cny)) {
    entry = { ...entry, ...entry.cny };
  }
  let tier = selectedTier(entry, atMs, config);
  if (!tier) {
    return unavailable('price-tier-unavailable', {
      usage: usageValue,
      provider: String(provider || ''),
      model: String(model || ''),
    });
  }

  const inputLength = (usageValue.inputTokens || 0)
    + (usageValue.cacheReadTokens || 0)
    + (usageValue.cacheWriteTokens || 0);
  if (
    isObject(tier.longContext)
    && inputLength > (finite(tier.longContext.aboveInputTokens) ?? Infinity)
  ) {
    tier = tier.longContext;
  }

  const callCost = (
    (usageValue.inputTokens || 0) * (finite(tier.cacheMiss) ?? 0)
    + (usageValue.cacheReadTokens || 0) * (finite(tier.cacheHit) ?? 0)
    + (usageValue.cacheWriteTokens || 0)
      * (finite(tier.cacheWrite) ?? finite(tier.cacheHit) ?? 0)
    + (usageValue.outputTokens || 0) * (finite(tier.output) ?? 0)
    + (usageValue.reasoningTokens || 0) * (finite(tier.reasoning) ?? 0)
  ) / 1_000_000;

  let cost = callCost;
  if (priceCurrency === 'CNY') {
    // Already the requested display currency.
  } else if (priceCurrency === 'USD') {
    const exchangeRate = finite(config.fxRates?.CNY) ?? finite(config.exchangeRate);
    if (exchangeRate === null || exchangeRate <= 0) {
      return unavailable('exchange-rate-unavailable', {
        usage: usageValue,
        provider: String(provider || ''),
        model: String(model || ''),
      });
    }
    cost *= exchangeRate;
  } else {
    return unavailable('price-currency-unsupported', {
      usage: usageValue,
      provider: String(provider || ''),
      model: String(model || ''),
    });
  }

  return {
    status: 'estimated',
    estimated: true,
    cost: Math.round(Math.max(0, cost) * 100_000_000) / 100_000_000,
    currency: 'CNY',
    symbol: '¥',
    source: 'dsh-cost-meter-price',
    reason: '',
    at: atMs,
    provider: String(provider || ''),
    model: String(model || ''),
    calls: Math.max(1, Math.trunc(finite(usage?.calls) ?? 1)),
    usage: usageValue,
  };
}

/**
 * Combine the two role estimates for one companion turn.
 *
 * A missing side never becomes zero. The total contains only successfully
 * estimated roles and is marked partial when either side is unavailable.
 */
export function combineModelRoleCosts(judge, reply) {
  const roles = [judge, reply].filter(isObject);
  const known = roles.filter((item) => item.status === 'estimated' || item.status === 'partial');
  const total = known.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const totalCny = known.length
    ? Math.round(Math.max(0, total) * 100_000_000) / 100_000_000
    : null;
  return {
    version: 1,
    currency: 'CNY',
    symbol: '¥',
    source: 'dsh-cost-meter-price',
    status: known.length === 2 && roles.length === 2
      ? 'estimated'
      : known.length
        ? 'partial'
        : 'unavailable',
    totalCny,
    judge: isObject(judge) ? judge : unavailable('usage-missing'),
    reply: isObject(reply) ? reply : unavailable('usage-missing'),
  };
}

/**
 * Lazily use the public costMeter.getState() API and cache the price snapshot.
 * A model call without a matching price remains explicitly uncollected.
 */
export function createDshCostEstimator({
  getMeter = () => null,
  clock = () => Date.now(),
  cacheMs = 30_000,
  log = () => {},
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  async function stateSnapshot() {
    const now = Number(clock());
    if (cached && now - cachedAt < cacheMs) return cached;
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => {
        const meter = getMeter();
        return meter && typeof meter.getState === 'function' ? meter.getState() : null;
      })
      .then((state) => {
        cached = isObject(state?.config) ? state : isObject(state?.value?.config) ? state.value : null;
        cachedAt = now;
        return cached;
      })
      .catch((error) => {
        try {
          log(`emotion cost state unavailable: ${(error && (error.code || error.name)) || 'Error'}`);
        } catch {
          /* price lookup is best effort */
        }
        cached = null;
        cachedAt = now;
        return null;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  async function estimateUsage(input = {}) {
    const usage = usageNumbers(input.usage);
    if (usage.totalTokens === null) return unavailable('usage-missing');
    const state = await stateSnapshot();
    if (!state) {
      return unavailable('cost-meter-unavailable', {
        usage,
        provider: String(input.provider || ''),
        model: String(input.model || ''),
      });
    }
    return estimateUsageFromState({
      state,
      usage: { ...usage, calls: input.usage?.calls },
      provider: input.provider,
      model: input.model,
      at: input.at ?? Number(clock()),
    });
  }

  async function estimateUsageBatch(parts, options = {}) {
    const values = (Array.isArray(parts) ? parts : [])
      .filter((part) => isObject(part) && isObject(part.usage));
    if (!values.length) return unavailable('usage-missing');
    const estimates = await Promise.all(values.map((part) => estimateUsage(part)));
    const estimated = estimates.filter((item) => item.status === 'estimated');
    const usage = sumUsage(values.map((part) => usageNumbers(part.usage)));
    if (!estimated.length) {
      return {
        ...estimates.find((item) => item.status === 'unavailable') || unavailable('price-unavailable'),
        usage,
      };
    }
    const providers = [...new Set(estimated.map((item) => item.provider).filter(Boolean))];
    const models = [...new Set(estimated.map((item) => item.model).filter(Boolean))];
    const cost = estimated.reduce((sum, item) => sum + Number(item.cost || 0), 0);
    return {
      status: estimated.length === estimates.length ? 'estimated' : 'partial',
      estimated: true,
      cost: Math.round(Math.max(0, cost) * 100_000_000) / 100_000_000,
      currency: 'CNY',
      symbol: '¥',
      source: 'dsh-cost-meter-price',
      reason: estimated.length === estimates.length ? '' : 'partial-price-or-usage',
      at: options.at ?? Number(clock()),
      provider: providers.length === 1 ? providers[0] : providers.join(', '),
      model: models.length === 1 ? models[0] : models.join(', '),
      calls: values.reduce((sum, part) => sum + Math.max(1, Math.trunc(finite(part.usage?.calls) ?? 1)), 0),
      usage,
    };
  }

  return {
    estimateUsage,
    estimateUsageBatch,
    prime: stateSnapshot,
  };
}

export function normalizeUsage(usage) {
  return usageNumbers(usage);
}
