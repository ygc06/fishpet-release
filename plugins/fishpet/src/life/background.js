/**
 * 后台生活：她自己的小事、程序判成败、同一件事最多两次发酵。
 *
 * 外部调用模型必须通过 `call(system,user)` 注入；未接模型时本模块只记录
 * “该动了”，不会假装后台已经生成了内容。关闭期间只补算时间，不发请求。
 *
 * @module dsh-fishpet-emotion/life/background
 */

export const DAY = 86400;
export const PASS_GAP = 40 * 60;
export const PASS_DAILY_MAX = 6;
export const SILENCE_MIN = 90 * 60;
export const NIGHT = Object.freeze([0, 7]);
export const TASK_LIFE = 3 * DAY;
export const FERMENT_MAX = 2;
export const STOP_AT = Object.freeze(['算了', '还想问', '记一笔']);
export const IDLE_ACTIVITY_AFTER = SILENCE_MIN;
export const IDLE_ACTIVITY_TIERS = Object.freeze([90 * 60, 3 * 3600, 6 * 3600]);

/**
 * 后台状态的内部时间统一用 Unix 秒。历史调用里同时出现过秒和毫秒，
 * 在入口一次性归一，避免 `now - lastUserAt` 量纲不同再次算出几十亿分钟。
 *
 * @param {unknown} value
 * @returns {number} 非正数或坏值返回 0。
 */
export function toUnixSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number >= 10_000_000_000 ? number / 1000 : number;
}

export const LOCAL_ACTIVITIES = Object.freeze({
  1: Object.freeze([
    { kind: 'cos', text: '翻了一会儿蓝色鲸鱼 Cos 图' },
    { kind: 'accessory', text: '给鲸鱼发夹换了几个位置' },
    { kind: 'outfit', text: '试了几套蓝白色的小衣服' },
    { kind: 'collection', text: '把桌上的鲸鱼挂件重新排了一遍' },
  ]),
  2: Object.freeze([
    { kind: 'cos', text: '研究了一条新的鲸鱼尾巴配饰' },
    { kind: 'plush', text: '给鲸鱼玩偶排队排了半天' },
    { kind: 'game', text: '自己玩了一会儿小游戏' },
    { kind: 'outfit', text: '把蓝色围巾搭出了三种新样子' },
  ]),
  3: Object.freeze([
    { kind: 'cos', text: '翻完了半册蓝鲸 Cos 照片' },
    { kind: 'game', text: '玩了很久换装小游戏' },
    { kind: 'music', text: '听着歌发了一会儿呆' },
    { kind: 'collection', text: '把鲸鱼收藏摆成了一个新阵型' },
  ]),
});

/**
 * @returns {object}
 */
export function createBackgroundState() {
  return {
    ver: 1,
    day: '',
    last_pass_id: '',
    passes_today: 0,
    last_pass_at: 0,
    backdrop: {
      task: null,
      body: '',
      mood_note: '',
      updated_at: 0,
      outcome: null,
    },
    ferment: {},
    local_activity: null,
    // First background observation for a brand-new install. It gives a real
    // silence baseline before the owner has sent their first message.
    watched_since: 0,
    queue: [],
    log_tail: [],
  };
}

/**
 * 按沉默时长分档。只有真实达到 90 分钟才进入“自己玩”的第一档。
 *
 * @param {number} silenceSec
 * @returns {number} 0 表示还没到阈值，1..3 表示活动档位。
 */
export function idleActivityLevel(silenceSec) {
  const silence = Math.max(0, Number(silenceSec) || 0);
  if (silence < IDLE_ACTIVITY_TIERS[0]) return 0;
  if (silence < IDLE_ACTIVITY_TIERS[1]) return 1;
  if (silence < IDLE_ACTIVITY_TIERS[2]) return 2;
  return 3;
}

/**
 * 用“当天 + 档位”做确定性选择，不联网、不调用模型，也不因每五分钟 tick 就编新剧情。
 *
 * @param {number} now
 * @param {number} level
 * @param {number} [anchor]
 * @returns {{kind: string, text: string}}
 */
export function pickLocalActivity(now, level, anchor = 0) {
  now = toUnixSeconds(now);
  anchor = toUnixSeconds(anchor);
  const tier = Math.max(1, Math.min(3, Math.trunc(Number(level) || 1)));
  const pool = LOCAL_ACTIVITIES[tier];
  const segment = Math.max(0, Math.trunc(anchor));
  const seed = `${dayKey(now)}|idle|${tier}|${segment}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return pool[(hash >>> 0) % pool.length];
}

/**
 * 在后台 pass 中刷新本地活动。沉默程度只前进不倒退；同一档每天只新建一次。
 *
 * @param {object} input
 * @param {number} now
 * @param {number} lastUserAt
 * @returns {{state: object, activity: object|null, created: boolean}}
 */
export function refreshLocalActivity(input, now, lastUserAt) {
  const state = normalize(input);
  now = toUnixSeconds(now) || toUnixSeconds(Date.now());
  lastUserAt = toUnixSeconds(lastUserAt);
  const anchor = lastUserAt > 0
    ? lastUserAt
    : state.watched_since || now;
  if (!state.watched_since) state.watched_since = round(now, 1);
  const silence = Math.max(0, now - anchor);
  const level = idleActivityLevel(silence);
  if (!level) return { state, activity: state.local_activity || null, created: false };

  const current = state.local_activity;
  const day = dayKey(now);
  if (
    current
    && current.day === day
    && Number(current.anchor || 0) === round(anchor, 1)
    && Number(current.level || 0) >= level
  ) {
    return { state, activity: current, created: false };
  }

  const picked = pickLocalActivity(now, level, anchor);
  state.local_activity = {
    id: `${day}-${level}-${picked.kind}-${Math.trunc(anchor)}`,
    day,
    level,
    anchor: round(anchor, 1),
    kind: picked.kind,
    text: picked.text,
    started_at: round(now, 1),
    seen_at: 0,
  };
  return { state, activity: state.local_activity, created: true };
}

/**
 * 只返回一次尚未在聊天里出现过的本地活动，并在同一份 Layer 2 状态里记账。
 * 调用方提交状态后，同一件事不会被每轮反复拿出来说。
 *
 * @param {object} input
 * @param {number} now
 * @returns {string}
 */
export function consumeLocalActivityLine(input, now) {
  const state = normalize(input);
  now = toUnixSeconds(now) || toUnixSeconds(Date.now());
  const activity = state.local_activity;
  if (
    !activity
    || !String(activity.text || '').trim()
    || Number(activity.seen_at || 0) >= Number(activity.started_at || 0)
  ) {
    return '';
  }
  activity.seen_at = round(now, 1);
  return `【她这段时间自己做的事】${clean(activity.text, 40)}。这是本地活动记录，可以自然提一次，不要编成主人也在场。`;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object}
 */
export function resetBackgroundDay(input, now) {
  const state = normalize(input);
  now = toUnixSeconds(now) || toUnixSeconds(Date.now());
  const day = dayKey(now);
  if (state.day !== day) {
    state.day = day;
    state.passes_today = 0;
  }
  return state;
}

/**
 * @param {number} now
 * @returns {boolean}
 */
export function isNight(now) {
  now = toUnixSeconds(now) || toUnixSeconds(Date.now());
  const hour = new Date(now * 1000).getHours();
  return hour >= NIGHT[0] && hour < NIGHT[1];
}

/**
 * @param {object} input
 * @param {number} now
 * @param {number} lastUserAt
 * @param {number} openItems
 * @param {number} awakeGap
 * @returns {{should: boolean, reason: string}}
 */
export function shouldPass(input, now, lastUserAt, openItems = 0, awakeGap = PASS_GAP) {
  now = toUnixSeconds(now) || toUnixSeconds(Date.now());
  lastUserAt = toUnixSeconds(lastUserAt);
  const state = resetBackgroundDay(input, now);
  if (!state.watched_since) state.watched_since = round(now, 1);
  const silenceAnchor = lastUserAt > 0
    ? lastUserAt
    : state.watched_since;
  if (isNight(now)) return { should: false, reason: '夜里不动' };
  if (now - Number(state.last_pass_at || 0) < Number(awakeGap)) return { should: false, reason: '刚动过' };
  if (Number(state.passes_today || 0) >= PASS_DAILY_MAX) return { should: false, reason: '今天够了' };
  const silence = Math.max(0, now - silenceAnchor);
  if (silence < SILENCE_MIN) return { should: false, reason: '他还在，不必自己找事' };
  if (openItems) return { should: true, reason: `沉默 ${Math.trunc(silence / 60)} 分钟，有件事还挂着` };
  const task = state.backdrop.task;
  if (!task) return { should: true, reason: `沉默 ${Math.trunc(silence / 60)} 分钟，她该给自己找点事` };
  if (now - Number(state.backdrop.updated_at || 0) >= awakeGap) return { should: true, reason: '手上的事该往前挪一点' };
  return { should: false, reason: '没什么可动的' };
}

/**
 * @param {object} input
 * @param {number} now
 * @param {Function|object} pick
 * @returns {object|null}
 */
export function ensureBackgroundTask(input, now, pick) {
  const state = normalize(input);
  let task = state.backdrop.task;
  if (task && now - Number(task.started_at || now) > TASK_LIFE) {
    closeTask(state, now, null, '挂太久了，自己淡了');
    task = null;
  }
  if (!task) {
    const got = typeof pick === 'function' ? pick() : pick;
    if (got && typeof got === 'object' && String(got.name || '').trim()) {
      state.backdrop.task = {
        name: String(got.name).slice(0, 24),
        due_at: now + 2 * DAY,
        started_at: now,
        difficulty: Math.trunc(Number(got.difficulty || 2)),
        progress: [],
        interrupts: 0,
      };
      state.backdrop.updated_at = now;
    }
  }
  return state.backdrop.task;
}

/**
 * @param {object} input
 * @param {number} now
 * @param {number} energy
 * @returns {{ok: boolean|null, why: string}}
 */
export function judgeBackgroundTask(input, now, energy = 65) {
  const state = normalize(input);
  const task = state.backdrop.task;
  if (!task) return { ok: null, why: '没有手上的事' };
  const progress = Array.isArray(task.progress) ? task.progress.length : 0;
  const difficulty = Number(task.difficulty || 2);
  const interrupts = Number(task.interrupts || 0);
  const need = 3 + difficulty;
  const score = progress * 2 + (Number(energy) - 50) / 25 - Math.min(3, interrupts) * 0.8;
  const ok = score >= need;
  return {
    ok,
    why: `进度${progress}、精力${Math.trunc(energy)}、被打断${interrupts}次、难度${difficulty} → ${ok ? '赶上了' : '没赶上'}`,
  };
}

/**
 * @param {object} input
 * @param {number} now
 * @param {number} energy
 * @param {string} note
 * @returns {object|null}
 */
export function tickBackgroundTask(input, now, energy = 65, note = '') {
  const state = normalize(input);
  const task = state.backdrop.task;
  if (!task) return null;
  if (!Array.isArray(task.progress)) task.progress = [];
  task.progress.push({ at: round(now, 1), note: String(note || '').slice(0, 40) });
  state.backdrop.updated_at = now;
  if (now >= Number(task.due_at || 0)) {
    const judged = judgeBackgroundTask(state, now, energy);
    closeTask(state, now, judged.ok, judged.why);
    return null;
  }
  return task;
}

/**
 * @param {object} input
 * @returns {string}
 */
export function backgroundLine(input) {
  const bd = normalize(input).backdrop;
  const bits = [];
  if (bd.task) bits.push('手上：' + String(bd.task.name || ''));
  if (bd.body) bits.push(String(bd.body));
  if (bd.mood_note) bits.push(String(bd.mood_note));
  return bits.filter(Boolean).join('；').slice(0, 60);
}

/**
 * @param {object} item
 * @returns {string}
 */
export function fermentKey(item) {
  return (String(item?.type || '') + '|' + String(item?.quote || '')).slice(0, 80);
}

/**
 * @param {object} input
 * @param {object} item
 * @param {number} now
 * @returns {{allowed: boolean, reason: string}}
 */
export function canFerment(input, item, now) {
  const state = normalize(input);
  const record = state.ferment[fermentKey(item)] || {};
  if (Number(record.times || 0) >= FERMENT_MAX) return { allowed: false, reason: '这件事已经想过两次了' };
  if (now - Number(record.last_at || 0) < 6 * 3600) return { allowed: false, reason: '刚想过' };
  return { allowed: true, reason: '可以想' };
}

/**
 * @param {object} input
 * @param {object} item
 * @param {object} got
 * @param {number} now
 * @param {boolean} dryRun
 * @returns {object}
 */
export function applyFerment(input, item, got, now, dryRun = true) {
  const state = normalize(input);
  const key = fermentKey(item);
  const record = state.ferment[key] || { times: 0 };
  const read = clean(got?.read, 40);
  let stop = clean(got?.stop_at, 8);
  if (!STOP_AT.includes(stop)) stop = '记一笔';
  const word = clean(got?.word, 8);
  record.times = Number(record.times || 0) + (dryRun ? 0 : 1);
  record.last_at = round(now, 1);
  record.read = read;
  record.stop_at = stop;
  record.word = word && word.length <= 8 ? word : '';
  record.at = round(now, 1);
  state.ferment[key] = record;
  return record;
}

/**
 * @param {object} input
 * @param {number} now
 * @param {Function|null} call
 * @param {object} options
 * @returns {object}
 */
export async function runBackgroundPass(input, now, call, options = {}) {
  now = toUnixSeconds(now) || toUnixSeconds(Date.now());
  const state = normalize(input);
  const openItems = Array.isArray(options.openItems) ? options.openItems : [];
  const dryRun = options.dryRun !== false;
  const energy = finiteEnergy(options.energy, 65);
  resetBackgroundDay(state, now);
  const explicitLastUserAt = toUnixSeconds(options.lastUserAt);
  const hasUserBaseline = explicitLastUserAt > 0;
  if (!hasUserBaseline && !(state.watched_since > 0)) {
    state.watched_since = round(now, 1);
  }
  const watchedSince = hasUserBaseline ? explicitLastUserAt : state.watched_since;
  const timing = shouldPass(state, now, watchedSince, openItems.length, options.awakeGap);
  const record = { ok: true, at: round(now, 1), why: timing.reason, did: [], dry: dryRun };
  if (!timing.should) return record;
  state.last_pass_at = now;
  if (!dryRun) state.passes_today = Number(state.passes_today || 0) + 1;

  const local = refreshLocalActivity(state, now, explicitLastUserAt);
  if (local.created) record.did.push('自己玩：' + local.activity.text);

  const task = ensureBackgroundTask(state, now, options.pickTask || (() => null));
  if (task) {
    let note = '';
    if (typeof call === 'function') {
      const [system, user] = makeDayPrompt(task, state.backdrop.body);
      let raw = '';
      try {
        raw = await call(system, user);
      } catch {
        record.ok = false;
        record.error = 'model-call-failed';
      }
      const got = parseBackgroundJson(raw);
      note = clean(got.progress, 30);
      if (got.body) state.backdrop.body = clean(got.body, 30);
      if (!got.progress && record.ok) {
        record.ok = false;
        record.error = 'model-empty';
      }
    }
    if (note && !dryRun) tickBackgroundTask(state, now, energy, note);
    if (note) record.did.push('日子：' + note);
    else if (typeof call !== 'function') record.did.push('日子：该推进了（没接模型）');
    else record.did.push('日子：模型没有给出可用进展');
  }

  const current = state.backdrop.task;
  if (current && now >= Number(current.due_at || 0)) {
    const judged = judgeBackgroundTask(state, now, energy);
    if (!dryRun) closeTask(state, now, judged.ok, judged.why);
    record.did.push('手上的事' + (judged.ok ? '成了' : '没成') + '：' + judged.why);
  }

  for (const item of openItems) {
    const allowed = canFerment(state, item, now);
    if (!allowed.allowed) continue;
    if (typeof call !== 'function') {
      record.did.push('该发酵了（没接模型）');
      break;
    }
    const [system, user] = makeFermentPrompt(item, options.inner || '', state.backdrop.body, current?.name, now);
    let raw = '';
    try {
      raw = await call(system, user);
    } catch {
      record.ok = false;
      record.error = 'model-call-failed';
      record.did.push('发酵：模型调用失败');
      break;
    }
    const got = parseBackgroundJson(raw);
    if (!got.read) {
      record.did.push('发酵：模型没给出解释');
      break;
    }
    const fermented = applyFerment(state, item, got, now, dryRun);
    record.did.push(`发酵：「${fermented.read}」→${fermented.stop_at}`);
    break;
  }

  const line = backgroundLine(state);
  if (line && !dryRun) {
    state.queue = (state.queue || []).slice(-1).concat({ at: round(now, 1), line });
  }
  record.line = line;
  state.log_tail.push(record);
  state.log_tail = state.log_tail.slice(-20);
  return record;
}

/**
 * @param {object} task
 * @param {string} body
 * @returns {[string, string]}
 */
export function makeDayPrompt(task, body) {
  return [
    '你在替一个人写她自己那一小块日子。只输出一个 JSON，不要别的话。\n规矩：一句手上的事进展，一句身体或状态，各不超过 20 字；\n不许写具体人名和剧情（不许连载），不许提任何人，不许写成心情总结。\n字段：{"progress":"一句进展","body":"一句身体或状态"}',
    `手上的事：${clean(task?.name, 20)}\n她这两天：${clean(body, 40) || '照常'}`,
  ];
}

/**
 * @param {object} item
 * @param {string} inner
 * @param {string} body
 * @param {string} taskName
 * @param {number} now
 * @returns {[string, string]}
 */
export function makeFermentPrompt(item, inner, body, taskName, now) {
  const date = new Date(now * 1000);
  const stamp = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return [
    '你在替一个人把同一件事重新想一遍。只输出一个 JSON，不要别的话。\n规矩：\n1. 事实一个字都不许改，也不许加以前没发生过的细节。\n2. 只准换解释，不超过 30 字。\n3. 必须落到一个动作：算了 / 还想问 / 记一笔。\n4. 不许写成小作文，不许安慰自己，不许下结论说对方是什么人。\n字段：{"read":"一句新解释","stop_at":"算了|还想问|记一笔","word":"可能要改的那个词，没有就空"}',
    `那件事（原话，不许改）：${clean(item?.quote || item?.text, 80) || '（没说清是哪句）'}\n当时她心里那句：${clean(inner, 60) || '（没记）'}\n她这两天：${clean(body, 40) || '（照常）'}\n她手上还有：${clean(taskName, 20) || '（没什么事）'}\n现在：${stamp}`,
  ];
}

/**
 * @param {unknown} text
 * @returns {object}
 */
export function parseBackgroundJson(text) {
  if (!text) return {};
  let value = String(text).trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) value = value.slice(start, end + 1);
  try {
    const got = JSON.parse(value);
    return got && typeof got === 'object' && !Array.isArray(got) ? got : {};
  } catch {
    return {};
  }
}

/**
 * @param {object} input
 * @returns {object[]}
 */
export function pullOpenItems(input, limit = 8) {
  const items = [];
  const scopes = input?.scopes;
  if (scopes && typeof scopes === 'object') {
    for (const bucket of Object.values(scopes)) {
      if (bucket && Array.isArray(bucket.items)) items.push(...bucket.items);
    }
  } else if (Array.isArray(input)) {
    items.push(...input);
  }
  return items
    .filter((item) => item && typeof item === 'object' && !item.solved && !item.closed_by)
    .sort((a, b) => Number(b.last_mention || b.at || 0) - Number(a.last_mention || a.at || 0))
    .slice(0, limit);
}

function closeTask(state, now, ok, why) {
  state.backdrop.outcome = { ok: ok === null ? null : Boolean(ok), why: String(why || '').slice(0, 60), at: now };
  state.backdrop.task = null;
  state.backdrop.updated_at = now;
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createBackgroundState();
  const blank = createBackgroundState();
  for (const [key, value] of Object.entries(blank)) if (!(key in input)) input[key] = value;
  if (!Number.isFinite(Number(input.watched_since)) || Number(input.watched_since) < 0) {
    input.watched_since = 0;
  } else {
    input.watched_since = toUnixSeconds(input.watched_since);
  }
  if (Number.isFinite(Number(input.last_pass_at)) && Number(input.last_pass_at) > 0) {
    input.last_pass_at = toUnixSeconds(input.last_pass_at);
  }
  if (!input.backdrop || typeof input.backdrop !== 'object') input.backdrop = blank.backdrop;
  for (const [key, value] of Object.entries(blank.backdrop)) if (!(key in input.backdrop)) input.backdrop[key] = value;
  if (!input.ferment || typeof input.ferment !== 'object') input.ferment = {};
  if (input.local_activity !== null && (!input.local_activity || typeof input.local_activity !== 'object')) {
    input.local_activity = null;
  } else if (input.local_activity) {
    for (const key of ['anchor', 'started_at', 'seen_at']) {
      if (Number.isFinite(Number(input.local_activity[key])) && Number(input.local_activity[key]) > 0) {
        input.local_activity[key] = toUnixSeconds(input.local_activity[key]);
      }
    }
  }
  if (!Array.isArray(input.queue)) input.queue = [];
  if (!Array.isArray(input.log_tail)) input.log_tail = [];
  return input;
}

function clean(value, limit) {
  return String(value || '').trim().replace(/\n/g, ' ').slice(0, limit);
}

function dayKey(seconds) {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function finiteEnergy(value, fallback) {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) ? number : fallback;
}
