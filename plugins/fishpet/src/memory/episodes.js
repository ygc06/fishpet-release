/**
 * 事件册：旧账、复燃、关闭、记忆和可复现的“忽然想起”。
 *
 * 所有数据都存在调用方传入的纯对象里；本模块不读写文件。scope 必填或默认为空，
 * 但空 scope 只用于单用户场景，迁移时必须由上层隔离。
 *
 * @module dsh-fishpet-emotion/memory/episodes
 */

export const EPISODE_TYPES = Object.freeze([
  '亲近',
  '挑刺',
  '失约',
  '拒绝',
  '冷落',
  '修复',
  '普通',
  '欠他',
  '记着',
]);

export const RECALL_MARKER = '【压在心里的旧事】';

const EVIDENCED = new Set(['挑刺', '失约', '拒绝', '冷落']);
const MIN_SALIENCE = 6;
const MIN_SALIENCE_GOOD = 3;
const KEEP_GOOD = 21 * 86400;
const KEEP_CLOSED = 7 * 86400;
const TAIL_MIN_MAG = 6;
const NEG_TYPES = new Set(['挑刺', '失约', '拒绝', '冷落', '记着', '欠他']);
const DUP_WINDOW = 180;
const REPEAT_WINDOW = 6 * 3600;
const REPEAT_MULT = 0.4;
const REPEAT_SESSION = 30 * 60;
const REPEAT_MULT_FLOOR = 0.3;
const REPEAT_MULT_FLOOR_WEAK = 0.55;
const REPEAT_MULT_WEAK = 0.7;
const TAIL_PER = 0.25;
const TAIL_MAX = 1.5;
const TAIL_WINDOW = 12 * 3600;
const FADE = 48 * 3600;
const MAX_ITEMS = 4000;
const FORCE_NEG = -15;
const MEMORY_MAX = 400;
const MEMORY_SIM = 0.8;
const MEMORY_DUP_SEC = 86400;

const APOLOGY = Object.freeze([
  '对不起',
  '抱歉',
  '是我不好',
  '我错了',
  '我说重了',
  '我不是这个意思',
  '怪我',
  '我道歉',
  '话说过了',
]);

const APOLOGY_DENY = Object.freeze([
  '不是我的错',
  '我道什么歉',
  '凭什么道歉',
  '你道歉',
  '他道歉',
  '她说对不起',
  '他说抱歉',
  '别道歉',
  '不用道歉',
  '没对不起',
]);

const DROP_WORDS = Object.freeze(['没事了', '过去了', '不怪你', '没往心里去', '没生气', '算了算了']);

const STOP_GRAMS = new Set([
  '我们', '你们', '他们', '什么', '怎么', '这个', '那个', '就是', '不是', '可以',
  '一个', '没有', '知道', '觉得', '现在', '时候', '自己', '因为', '所以', '但是',
]);

/**
 * @returns {{scopes: Record<string, {items: object[], last: object}>, memory: object[]}}
 */
export function createEpisodeState() {
  return { scopes: {}, memory: [] };
}

/**
 * 旧数据升级：
 * - 平铺 items/last -> 空 scope；
 * - memory 对象表 -> 按稳定键排序的数组，保留原 id/对象键，数量必须守恒。
 *
 * @param {unknown} raw
 * @returns {object}
 */
export function migrateEpisodeData(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? clone(raw) : {};
  if (Array.isArray(data.items)) {
    data.scopes = {
      '': {
        items: data.items,
        last: data.last && typeof data.last === 'object'
          ? data.last
          : Number.isFinite(Number(data.last))
            ? { at: Number(data.last) }
            : {},
      },
    };
    delete data.items;
    delete data.last;
  }
  if (!data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) {
    data.scopes = {};
  }
  for (const [scope, bucket] of Object.entries(data.scopes)) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
      data.scopes[scope] = { items: [], last: {} };
      continue;
    }
    if (!Array.isArray(bucket.items)) bucket.items = [];
    if (!bucket.last || typeof bucket.last !== 'object' || Array.isArray(bucket.last)) {
      bucket.last = Number.isFinite(Number(bucket.last)) ? { at: Number(bucket.last) } : {};
    }
  }

  if (Array.isArray(data.memory)) {
    // 旧数组里有坏记录时不能 filter 掉后继续迁移：那会悄悄改变用户记忆数量，
    // 调用方也无从知道丢了什么。与原对象表一样停机，交给上层隔离或人工确认。
    if (data.memory.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('memory-array-conservation');
    }
    data.memory = clone(data.memory);
  } else if (data.memory && typeof data.memory === 'object') {
    const entries = Object.entries(data.memory);
    const expected = entries.length;
    const memory = [];
    for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      memory.push({ ...clone(value), id: value.id || key });
    }
    if (memory.length !== expected) {
      throw new Error('memory-object-table-conservation');
    }
    data.memory = memory;
  } else {
    data.memory = [];
  }
  return data;
}

/**
 * @param {object} state
 * @param {string} scope
 * @returns {{items: object[], last: object}}
 */
export function getBucket(state, scope = '') {
  state.scopes ||= {};
  const key = String(scope || '');
  if (!state.scopes[key] || typeof state.scopes[key] !== 'object' || Array.isArray(state.scopes[key])) {
    state.scopes[key] = { items: [], last: {} };
  }
  if (!Array.isArray(state.scopes[key].items)) state.scopes[key].items = [];
  if (!state.scopes[key].last || typeof state.scopes[key].last !== 'object') state.scopes[key].last = {};
  return state.scopes[key];
}

/**
 * 记录一轮关系事件。
 *
 * @param {object} input
 * @param {object} args
 * @returns {object}
 */
export function observeEpisode(input, args = {}) {
  const state = normalizeState(input);
  const etype = EPISODE_TYPES.includes(String(args.etype || '')) ? String(args.etype) : '普通';
  const quote = String(args.quote || '').slice(0, 120);
  const text = String(args.text || '');
  const now = Number(args.now);
  const scope = String(args.scope || '');
  const bucket = getBucket(state, scope);
  const normText = normalize(text);
  const messageId = String(args.msgId || '');
  const salience = Number(args.salience || 0);

  if (messageId && messageId === bucket.last.mid) {
    return result(state, true, null, 0, null, false, 'duplicate-message-id', false);
  }
  if (!messageId && normText && normText === bucket.last.text && now - Number(bucket.last.at || 0) <= DUP_WINDOW) {
    return result(state, true, null, 0, null, false, 'duplicate-text-window', true);
  }
  bucket.last = { text: normText, at: now, mid: messageId };

  if (DROP_WORDS.some((word) => text.includes(word)) && EVIDENCED.has(etype)) {
    return result(state, false, null, 1, null, false, 'said-it-is-over', false);
  }
  if (etype === '修复' || (etype === '普通' && !(args.force && salience <= FORCE_NEG))) {
    return result(state, false, null, 1, null, false, 'not-an-event', false);
  }

  const quoteOk = args.quoteOk === true && Boolean(text) && Boolean(quote) && text.includes(quote);
  if (!quoteOk) {
    if (Math.abs(salience) >= MIN_SALIENCE) {
      const item = {
        id: nextId('e', now, bucket.items),
        type: etype,
        quote: '',
        quotes: [],
        emo: String(args.emo || '').slice(0, 8),
        who: String(args.who || '').slice(0, 24),
        mag: round(salience, 1),
        opened_at: now,
        last_mention: now,
        mentions: 1,
        recalls: 0,
        last_recalled: 0,
        solved: true,
        closed_at: now,
        closed_by: 'no-evidence',
        no_evidence: true,
      };
      bucket.items.push(item);
      prune(bucket.items, now);
      return result(state, false, null, 1, item, false, 'no-evidence', false);
    }
    return result(state, false, null, 1, null, false, 'no-evidence', false);
  }

  const threshold = etype === '亲近' ? MIN_SALIENCE_GOOD : MIN_SALIENCE;
  if (!EVIDENCED.has(etype) && Math.abs(salience) < threshold) {
    return result(state, false, null, 1, null, false, 'below-salience', false);
  }

  const repeat = findRepeat(bucket.items, etype, quote, now, String(args.label || ''));
  if (repeat.item) {
    const item = repeat.item;
    item.mentions = Number(item.mentions || 1) + 1;
    item.last_mention = now;
    item.hist = [...(Array.isArray(item.hist) ? item.hist : []), round(now, 3)].slice(-8);
    const quotes = Array.isArray(item.quotes) ? item.quotes.slice() : [];
    if (quote && !quotes.includes(quote)) quotes.push(quote);
    item.quotes = quotes.slice(-4);
    return result(state, false, item.id, repeat.mult, item, true, 'reopened', false);
  }

  const item = {
    id: nextId('e', now, bucket.items),
    type: etype,
    label: String(args.label || '').trim().slice(0, 12),
    quote,
    quotes: [quote],
    emo: String(args.emo || '').slice(0, 8),
    who: String(args.who || '').slice(0, 24),
    mag: round(salience, 1),
    opened_at: now,
    last_mention: now,
    mentions: 1,
    hist: [round(now, 3)],
    recalls: 0,
    last_recalled: 0,
    solved: args.unsolved === false,
    closed_at: args.unsolved === false ? now : 0,
    closed_by: args.unsolved === false ? 'model-said-over' : '',
  };
  bucket.items.push(item);
  prune(bucket.items, now);
  return result(state, false, null, 1, item, true, 'new', false);
}

/**
 * 模型自己写下的一笔账。
 *
 * @param {object} input
 * @param {object} args
 * @returns {object}
 */
export function markEpisode(input, args = {}) {
  const state = normalizeState(input);
  const now = Number(args.now);
  const bucket = getBucket(state, String(args.scope || ''));
  const body = String(args.what || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (body.length < 4) return { state, logged: false, why: 'too-short', item: null };
  const label = String(args.label || '').trim().slice(0, 12);
  for (const item of bucket.items) {
    if (item.solved) continue;
    const sameQuote = similarity(String(item.quote || ''), body) >= 0.62;
    const sameLabel = Boolean(label && item.label) && similarity(String(item.label), label) >= 0.5;
    if (!sameQuote && !sameLabel) continue;
    const seen = Number(item.mentions || 1);
    const gap = now - Number(item.last_mention || now);
    item.mentions = seen + 1;
    item.last_mention = now;
    if (label && !item.label) item.label = label;
    item.hist = [...(Array.isArray(item.hist) ? item.hist : []), round(now, 3)].slice(-8);
    return {
      state,
      logged: true,
      why: 'reopened',
      item,
      mult: repeatMultiplier(item, true, gap, seen),
    };
  }
  const item = {
    id: nextId('e', now, bucket.items),
    type: '记着',
    quote: body,
    quotes: [body],
    label,
    who: String(args.who || '他').slice(0, 6),
    emo: String(args.emo || '').slice(0, 8),
    mag: round(Math.max(1, Math.min(24, Number(args.weight || 0) * 2.2)), 1),
    opened_at: now,
    last_mention: now,
    mentions: 1,
    hist: [round(now, 3)],
    recalls: 0,
    last_recalled: 0,
    solved: args.unsolved === false,
    by: 'model',
  };
  if (item.solved) {
    item.closed_at = now;
    item.closed_by = 'model-said-over';
  }
  bucket.items.push(item);
  prune(bucket.items, now);
  return { state, logged: true, why: 'marked', item };
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {object}
 */
export function noteGood(input, args = {}) {
  const state = normalizeState(input);
  const now = Number(args.now);
  const bucket = getBucket(state, String(args.scope || ''));
  const body = String(args.what || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (body.length < 4) return { state, logged: false, why: 'too-short', item: null };
  for (const item of bucket.items) {
    if (item.type !== '亲近' || similarity(String(item.quote || ''), body) < 0.62) continue;
    item.mentions = Number(item.mentions || 1) + 1;
    item.last_mention = now;
    return { state, logged: true, why: 'same-good', item };
  }
  const item = {
    id: nextId('g', now, bucket.items),
    type: '亲近',
    quote: body,
    quotes: [body],
    label: String(args.label || '').trim().slice(0, 12),
    who: String(args.who || '他').slice(0, 6),
    emo: String(args.emo || '').slice(0, 8),
    mag: 0,
    opened_at: now,
    last_mention: now,
    mentions: 1,
    hist: [round(now, 3)],
    recalls: 0,
    last_recalled: 0,
    solved: true,
    by: 'model',
    closed_at: now,
    closed_by: 'good-note',
  };
  bucket.items.push(item);
  prune(bucket.items, now);
  return { state, logged: true, why: 'good', item };
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {object}
 */
export function noteOwn(input, args = {}) {
  const state = normalizeState(input);
  const now = Number(args.now);
  const bucket = getBucket(state, String(args.scope || ''));
  const body = String(args.what || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (body.length < 4) return { state, logged: false, why: 'too-short', item: null };
  for (const item of bucket.items) {
    if (item.type !== '欠他' || item.solved) continue;
    if (similarity(String(item.quote || ''), body) < 0.62) continue;
    item.mentions = Number(item.mentions || 1) + 1;
    item.last_mention = now;
    return { state, logged: true, why: 'same-own', item };
  }
  const item = {
    id: nextId('o', now, bucket.items),
    type: '欠他',
    quote: body,
    quotes: [body],
    label: String(args.label || '').trim().slice(0, 12),
    who: '我',
    emo: String(args.emo || '').slice(0, 8),
    mag: 0,
    opened_at: now,
    last_mention: now,
    mentions: 1,
    hist: [round(now, 3)],
    recalls: 0,
    last_recalled: 0,
    solved: false,
    by: 'model',
    closed_at: 0,
    closed_by: '',
  };
  bucket.items.push(item);
  prune(bucket.items, now);
  return { state, logged: true, why: 'own', item };
}

/**
 * 他真诚认错时关掉能对上的那一件。
 *
 * @param {object} input
 * @param {object} args
 * @returns {object|null}
 */
export function closeEpisode(input, args = {}) {
  const state = normalizeState(input);
  const text = String(args.text || '');
  if (APOLOGY_DENY.some((word) => text.includes(word))) return null;
  const said = APOLOGY.filter((word) => text.includes(word));
  if (!said.length || normalize(text).length < 8) return null;
  const bucket = getBucket(state, String(args.scope || ''));
  const candidates = bucket.items.filter((item) =>
    !item.solved && Number(item.mag || 0) >= TAIL_MIN_MAG && !item.no_evidence
  );
  if (!candidates.length) return null;
  let target = null;
  if (candidates.length === 1) {
    target = candidates[0];
  } else {
    const words = new Set([
      ...grams(text),
      ...(args.quoteOk ? grams(args.quote || '') : []),
    ]);
    const scored = candidates.map((item) => {
      const evidence = [item.quote || '', ...(Array.isArray(item.quotes) ? item.quotes : [])].join(' ');
      let score = 0;
      for (const gram of grams(evidence)) if (words.has(gram)) score += 1;
      return { score, item };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    target = scored[0].item;
  }
  target.solved = true;
  target.closed_at = Number(args.now);
  target.closed_by = shortText(text, 40);
  return target;
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {object|null}
 */
export function closeOwn(input, args = {}) {
  const state = normalizeState(input);
  const bucket = getBucket(state, String(args.scope || ''));
  const candidates = bucket.items
    .filter((item) => item.type === '欠他' && !item.solved)
    .sort((a, b) => Number(a.opened_at || 0) - Number(b.opened_at || 0));
  if (!candidates.length) return null;
  const item = candidates[candidates.length - 1];
  item.solved = true;
  item.closed_at = Number(args.now);
  item.closed_by = '她自己认了';
  item.close_text = String(args.text || '').slice(0, 60);
  return item;
}

/**
 * @param {object} input
 * @param {string} id
 * @param {object} args
 * @returns {object|null}
 */
export function noteEpisodeAsk(input, id, args = {}) {
  const state = normalizeState(input);
  const entries = args.scope !== undefined
    ? [[String(args.scope || ''), getBucket(state, String(args.scope || ''))]]
    : Object.entries(state.scopes);
  for (const [, bucket] of entries) {
    for (const item of Array.isArray(bucket.items) ? bucket.items : []) {
      if (String(item.id) !== String(id)) continue;
      const note = String(args.note || '').trim().slice(0, 40);
      item.asks = Number(item.asks || 0) + 1;
      item.last_ask_at = Number(args.now);
      if (note) item.last_note = note;
      if (args.answered) {
        item.answered_at = Number(args.now);
        if (note) item.answer = note;
        item.solved = true;
        item.closed_by ||= '他答了';
      }
      return item;
    }
  }
  return null;
}

/**
 * @param {object} input
 * @param {string} id
 * @param {string} label
 * @param {number} now
 * @returns {boolean}
 */
export function setEpisodeLabel(input, id, label, now) {
  const state = normalizeState(input);
  const value = String(label || '').trim().slice(0, 12);
  if (!value) return false;
  for (const bucket of Object.values(state.scopes)) {
    for (const item of Array.isArray(bucket.items) ? bucket.items : []) {
      if (String(item.id) !== String(id)) continue;
      item.label_before = String(item.label || '');
      item.label = value;
      item.label_at = Number(now);
      return true;
    }
  }
  return false;
}

/**
 * @param {object} input
 * @param {string} scope
 * @param {number} now
 * @returns {number}
 */
export function tailFactor(input, scope = '', now) {
  const state = normalizeState(input);
  const items = getBucket(state, scope).items;
  const count = items.filter((item) =>
    !item.solved &&
    isOwed(item) &&
    Number(item.mag || 0) >= TAIL_MIN_MAG &&
    !item.no_evidence &&
    Number(now) - Number(item.last_mention || 0) <= TAIL_WINDOW
  ).length;
  return count ? round(Math.min(TAIL_MAX, 1 + TAIL_PER * count), 2) : 1;
}

/**
 * @param {object} input
 * @param {string} scope
 * @returns {string}
 */
export function openEpisodeLine(input, scope = '') {
  const state = normalizeState(input);
  const live = getBucket(state, scope).items
    .filter((item) => !item.solved && isOwed(item) && Number(item.mag || 0) >= TAIL_MIN_MAG && !item.no_evidence)
    .sort((a, b) => Number(b.last_mention || 0) - Number(a.last_mention || 0));
  if (!live.length) return '';
  const item = live[0];
  const date = formatDay(Number(item.opened_at || 0));
  const when = date ? `（${date}）` : '';
  if (item.type === '记着') {
    const label = String(item.label || '').trim();
    return `她心里还记着${label ? `（${label}）` : ''}${when}：「${String(item.quote || '').slice(0, 60)}」`;
  }
  const table = {
    挑刺: '他之前那几句难听话，还没真说开',
    失约: '他放你鸽子那回，还搁在那儿',
    拒绝: '他拒绝你那次，你还没过去',
    冷落: '他消失那阵子，还没给你个说法',
    亲近: '他那次认真，你还记着',
  };
  let line = table[item.type] || '';
  if (!line) return '';
  line += Number(item.mentions || 1) > 1 ? `（这已经不是第一次提了${when}）` : when;
  return line;
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {object|null}
 */
export function rememberText(input, args = {}) {
  const state = normalizeState(input);
  const now = Number(args.now);
  const scope = String(args.scope || '');
  const body = String(args.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (body.length < 2) return null;
  for (const item of state.memory) {
    if (String(item.scope || '') !== scope) continue;
    if (Math.abs(Number(item.at || 0) - now) < MEMORY_DUP_SEC && similarity(String(item.text || ''), body) >= MEMORY_SIM) {
      return null;
    }
  }
  const item = {
    id: nextId('m', now, state.memory),
    text: body,
    emo: String(args.emo || '').slice(0, 8),
    who: String(args.who || '').slice(0, 24),
    scope,
    at: now,
    mag: round(Number(args.mag || 0), 1),
    recalls: 0,
    last_recalled: 0,
  };
  state.memory.push(item);
  if (state.memory.length > MEMORY_MAX) state.memory.splice(0, state.memory.length - MEMORY_MAX);
  return item;
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {{text: string, item?: object}}
 */
export function recallEpisode(input, args = {}) {
  const state = normalizeState(input);
  const now = Number(args.now);
  const scoped = args.scope || '';
  const text = String(args.text || '');
  const valence = Number(args.valence || 0);
  const negDelta = Number(args.negDelta || 0);
  const grudge = Number(args.grudge ?? 45);
  const scored = [];
  for (const item of state.memory) {
    if (String(item.scope || '') !== String(scoped)) continue;
    const sim = similarity(text, String(item.text || ''));
    if (negDelta > -2 && sim < 0.15) continue;
    let p = grudge * 0.15;
    if (negDelta <= -7) p += 12;
    else if (negDelta <= -3) p += 7;
    else if (negDelta < 0) p += 3;
    p += 45 * sim;
    p += 10 * Math.min(1, Math.abs(Number(item.mag || 0)) / 25);
    if (valence < -20) p += 5;
    if (sim < 0.15) p *= 0.6;
    p -= Math.min(12, Number(item.recalls || 0) * 4);
    if (now - Number(item.last_recalled || 0) < 6 * 3600) p = 0;
    p = Math.max(0, Math.min(85, p));
    if (p > 0) scored.push({ p, item });
  }
  scored.sort((a, b) => b.p - a.p);
  for (const entry of scored) {
    const luck = typeof args.draw === 'function'
      ? Number(args.draw(entry.item, text))
      : deterministicDraw(entry.item, text);
    if (luck < entry.p) {
      entry.item.recalls = Number(entry.item.recalls || 0) + 1;
      entry.item.last_recalled = now;
      return { text: formatRecall(entry.item), item: entry.item };
    }
  }
  return { text: '' };
}

/**
 * @param {object} item
 * @returns {string}
 */
export function formatRecall(item) {
  const who = item.who || '对方';
  const body = String(item.text || '').slice(0, 100);
  const emo = item.emo || '难受';
  return `${RECALL_MARKER}\n你忽然想起 ${formatDate(Number(item.at || 0))} 那天「${who}」说过的话：「${body}」。当时你挺${emo}的，一直没提。\n要不要翻出来，你自己看着办；不想提，就当没想起来。`;
}

/**
 * @param {object} input
 * @param {string} scope
 * @param {number} now
 * @param {number} days
 * @param {number} limit
 * @returns {object[]}
 */
export function goodEpisodes(input, scope = '', now, days = 14, limit = 3) {
  const state = normalizeState(input);
  return getBucket(state, scope).items
    .filter((item) => item.type === '亲近' && now - Number(item.last_mention || item.opened_at || 0) <= days * 86400)
    .sort((a, b) => Number(b.last_mention || 0) - Number(a.last_mention || 0))
    .slice(0, limit);
}

/**
 * @param {object} input
 * @returns {object}
 */
function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createEpisodeState();
  if (!input.scopes || typeof input.scopes !== 'object' || Array.isArray(input.scopes)) input.scopes = {};
  if (!Array.isArray(input.memory)) input.memory = [];
  return input;
}

function result(state, dup, matched, mult, item, logged, why, degraded) {
  return { state, dup, matched, mult, item, logged, why, degraded };
}

function repeatMultiplier(item, strong, gap, seen = Number(item.mentions || 1)) {
  const answered = Boolean(String(item.answer || '').trim());
  if (gap > REPEAT_SESSION) return answered ? REPEAT_MULT_FLOOR : 1;
  if (seen >= 2) return strong ? REPEAT_MULT_FLOOR : REPEAT_MULT_FLOOR_WEAK;
  return strong ? REPEAT_MULT : REPEAT_MULT_WEAK;
}

function findRepeat(items, type, quote, now, reason) {
  const quoteGrams = grams(quote);
  const reasonGrams = grams(reason);
  if (!quoteGrams.size && !reasonGrams.size) return { item: null, mult: 1 };
  let best = null;
  let bestStrong = false;
  let bestScore = 0;
  for (const item of items) {
    if (item.solved || item.type !== type) continue;
    if (now - Number(item.last_mention || 0) > REPEAT_WINDOW) continue;
    const itemGrams = grams(item.quote || '');
    let score = 0;
    for (const gram of quoteGrams) if (itemGrams.has(gram)) score += 1;
    const sameReason = reasonGrams.size > 0 && Boolean(item.label) && similarity(reason, String(item.label)) >= 0.5;
    if (score <= 0 && !sameReason) continue;
    const strong = score >= 2 || sameReason;
    if (!best || (strong && !bestStrong) || score > bestScore) {
      best = item;
      bestStrong = strong;
      bestScore = score;
    }
  }
  if (!best) return { item: null, mult: 1 };
  const gap = now - Number(best.last_mention || now);
  return { item: best, mult: repeatMultiplier(best, bestStrong, gap) };
}

function prune(items, now) {
  for (const item of items) {
    if (!item.solved && now - Number(item.last_mention || now) > FADE) {
      item.solved = true;
      item.closed_at = now;
      item.closed_by = 'faded';
    }
  }
  const keep = items.filter((item) => {
    if (!item.solved) return true;
    const duration = item.type === '亲近' ? KEEP_GOOD : KEEP_CLOSED;
    return now - Number(item.closed_at || 0) <= duration;
  });
  keep.sort((a, b) => Number(a.opened_at || 0) - Number(b.opened_at || 0));
  items.splice(0, items.length, ...keep.slice(-MAX_ITEMS));
}

function isOwed(item) {
  if (NEG_TYPES.has(String(item.type || ''))) return true;
  return Number(item.mag || 0) < 0;
}

export function normalize(text) {
  return String(text ?? '').replace(/[\s，。！？、；：“”‘’（）…,.!?;:"'()\-—]+/g, '').toLowerCase();
}

export function grams(text, size = 2) {
  const value = normalize(text);
  const out = new Set();
  for (let i = 0; i < Math.max(0, value.length - size + 1); i += 1) {
    out.add(value.slice(i, i + size));
  }
  return out;
}

export function similarity(a, b) {
  const left = new Set([...grams(a)].filter((gram) => !STOP_GRAMS.has(gram)));
  const right = new Set([...grams(b)].filter((gram) => !STOP_GRAMS.has(gram)));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection ? intersection / Math.min(left.size, right.size) : 0;
}

function deterministicDraw(item, text) {
  const seed = `${item.id || ''}|${normalize(text)}`;
  return (crc32(seed) % 1000) / 10;
}

let crcTable;
function crc32(text) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let j = 0; j < 8; j += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[i] = value >>> 0;
    }
  }
  const bytes = new TextEncoder().encode(text);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function nextId(prefix, now, items) {
  const base = `${prefix}${Math.trunc(Number(now) * 1000) % 10 ** 12}`;
  const used = new Set(items.map((item) => String(item.id)));
  let id = base;
  let suffix = 1;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function shortText(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= limit ? value : value.slice(0, limit) + '…';
}

function formatDate(seconds) {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDay(seconds) {
  const date = new Date(seconds * 1000);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
