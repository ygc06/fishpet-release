/**
 * 把一次已校验的判读结果应用到第 2 层状态。
 *
 * 这个模块只做内存投影，不写文件、不调模型。Host 必须把返回的整份状态放进
 * 同一个 `eventId` 的联合提交里；任何一步抛错都意味着本轮不允许落一半。
 *
 * @module dsh-fishpet-emotion/engine/apply
 */

import { actionLine } from './actions.js';
import { reparativeEvent, unresolvedAnger } from './anger.js';
import { decideEvent, repairHintLine } from './facts.js';
import { crisisHit, crisisLine } from './safety.js';
import {
  emotionHint,
  regulationLines,
  sootheEmotion,
  topLabel,
  touchEmotion,
} from './emotion.js';
import {
  applyRegulation,
  pickRegulation,
  reboundRegulation,
  regulationLine,
} from './regulation.js';
import { clampAxis, inBurst, splitBurst } from './saturation.js';
import { detectExtremes, extremeSnapshotLabel } from './extremes.js';
import {
  applyMessage,
  createMoodState,
  moodView,
} from './state.js';
import { describeFeelings } from './feel-language.js';
import {
  closeEpisode,
  closeOwn,
  getBucket,
  goodEpisodes,
  markEpisode,
  noteEpisodeAsk,
  noteGood,
  noteOwn,
  normalize as normalizeEpisodeText,
  observeEpisode,
  openEpisodeLine,
} from '../memory/episodes.js';
import {
  addCoreMemory,
  extractCoreTrigger,
  formatCoreMemory,
} from '../memory/core-memory.js';
import { renderPromises } from '../memory/promises.js';
import {
  captureInnerLife,
  innerLifeBlocks,
  noteInnerMessage,
  pickShareGap,
  pruneInnerLife,
} from '../inner/inner-life.js';
import { renderConflict } from '../inner/conflict.js';
import {
  judgementLine,
  shouldUpdateJudgement,
} from '../relationship/judgement.js';
import { refreshTrust } from '../relationship/trust.js';
import {
  compositeEmotion,
  detectTags,
  relationFrom,
} from '../relationship/context.js';
import {
  gateVitality,
  hardDirective,
  pendingEpiphany,
  markEpiphanyUsed,
  refreshVitality,
  renderEpiphany,
  renderVitality,
  spendVitality,
} from '../life/vitality.js';
import { renderInteroception } from '../life/interoception.js';
import {
  backgroundLine,
  consumeLocalActivityLine,
  createBackgroundState,
  pullOpenItems,
  runBackgroundPass,
  toUnixSeconds,
} from '../life/background.js';
import { createDefaultLayer2State } from '../store/schema-v2.js';

const DAY = 86400;
const HOUR = 3600;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

/**
 * 统一把毫秒时间戳换成第 2 层使用的 Unix 秒。
 *
 * @param {unknown} value
 * @param {number} fallbackMs
 * @returns {number}
 */
export function unixSeconds(value, fallbackMs = Date.now()) {
  const raw = Number(value);
  const stamp = Number.isFinite(raw) && raw > 0 ? raw : Number(fallbackMs);
  if (!Number.isFinite(stamp)) return 0;
  return stamp >= 10_000_000_000 ? stamp / 1000 : stamp;
}

/**
 * 关系 scope 只存在私有数据里；公开报告只给布尔和自然语言。
 *
 * @param {object} envelope
 * @returns {string}
 */
export function scopeFromEnvelope(envelope = {}) {
  const source = isObject(envelope.source) ? envelope.source : {};
  const raw = envelope.relationshipRef
    ?? envelope.actorId
    ?? source.relationshipRef
    ?? source.actorId
    ?? source.id
    ?? (typeof envelope.source === 'string' ? envelope.source : '')
    ?? 'default';
  return String(raw || 'default').trim().slice(0, 240) || 'default';
}

/**
 * 从旧会话关系账复制一次好感底子到稳定主人键。
 *
 * 旧会话本身不删，也不改它的账。新键只在尚不存在时播种，之后一直累计；
 * 这样切换人设会话时不会把好感归零，也不会覆盖新键已经积累的关系。
 *
 * @param {object} state 当前第 2 层状态（会被原地修正）。
 * @param {string} scope 新的稳定关系键。
 * @param {string} legacyScope 上一段会话使用的关系键。
 * @returns {boolean} 是否复制了旧好感。
 */
export function seedRelationshipContinuity(state, scope, legacyScope) {
  if (!isObject(state)) return false;
  const next = String(scope || '').trim().slice(0, 240);
  const previous = String(legacyScope || '').trim().slice(0, 240);
  if (!next || !previous || next === previous) return false;
  if (!isObject(state.affinity) || !isObject(state.affinity.users)) return false;
  if (isObject(state.affinity.users[next])) return false;
  const legacy = state.affinity.users[previous];
  if (!isObject(legacy)) return false;
  const copied = clone(legacy);
  if (!copied.name || /^dsh:session[-:]/.test(String(copied.name))) copied.name = next;
  state.affinity.users[next] = copied;
  return true;
}

function actorNameFromEnvelope(envelope = {}) {
  const input = isObject(envelope.input) ? envelope.input : {};
  const source = isObject(envelope.source) ? envelope.source : {};
  return String(envelope.actorName ?? input.actorName ?? source.actorName ?? source.name ?? '')
    .trim()
    .slice(0, 60);
}

function pushContext(state, envelope, utterance, now) {
  state.context ||= { recent: [], dialog: [], lastInjectionAt: 0 };
  state.context.recent = Array.isArray(state.context.recent) ? state.context.recent : [];
  state.context.dialog = Array.isArray(state.context.dialog) ? state.context.dialog : [];
  if (utterance) {
    state.context.recent.push({
      t: String(utterance).slice(0, 120),
      at: round(now, 1),
      owner: true,
    });
    state.context.dialog.push({
      role: '他',
      t: String(utterance).slice(0, 160),
      at: round(now, 1),
      eventId: String(envelope.eventId || ''),
    });
  }
  state.context.recent = state.context.recent.slice(-8);
  state.context.dialog = state.context.dialog.slice(-80);
}

function updateAffinity(state, scope, name, bond, now) {
  const users = state.affinity && isObject(state.affinity.users) ? state.affinity.users : {};
  state.affinity = { users };
  let record = users[scope];
  if (!record || !isObject(record)) {
    record = {
      name: name || scope,
      score: 30,
      first_seen: now,
      last_seen: now,
      msgs: 0,
      gain_day: state.mood.day,
      gain_today: 0,
    };
  } else {
    record = { ...record };
  }
  record.msgs = Number(record.msgs || 0) + 1;
  record.last_seen = now;
  if (name) record.name = name;

  const amount = Math.max(-2, Math.min(2, Number(bond) || 0)) * 0.6;
  if (amount) {
    const day = state.mood.day;
    if (record.gain_day !== day) {
      record.gain_day = day;
      record.gain_today = 0;
    }
    let applied = amount;
    if (applied > 0) {
      const room = Math.max(0, 6 - Number(record.gain_today || 0));
      applied = Math.min(applied, room);
      record.gain_today = round(Number(record.gain_today || 0) + applied, 2);
    }
    record.score = round(Math.max(0, Math.min(100, Number(record.score || 30) + applied)), 2);
  }
  users[scope] = record;
  return record;
}

function captureTextRules(state, utterance, now, scope, isOwner) {
  const coreTrigger = extractCoreTrigger(utterance);
  if (coreTrigger) {
    state.coreMemory = addCoreMemory(state.coreMemory, {
      text: coreTrigger,
      by: state.actorName || '他',
      byId: scope,
      source: 'chat',
      now,
    }).state;
  }

  // 旧活路径从 2026-11-08 起停用了“从他的话里自动抓规矩”。
  // skills 仍保留在 v2 状态中，供迁移和显式管理使用，但聊天轮次不能
  // 重新开启一套会自行扩张的规则。
  captureInnerLife(state.inner, { text: utterance, now, isOwner });
  noteInnerMessage(state.inner, now);
  pruneInnerLife(state.inner, now);
}

function applyEpisodeResult(state, result, envelope, event, utterance, now, scope, repeatMult) {
  const stateBefore = state.episodes;
  let episodeResult = null;
  let repeat = repeatMult;
  const label = String(event.label || result.ep?.label || '').trim().slice(0, 12);

  if (event.type === '修复') {
    let closed = null;
    if (event.who === '我') closed = closeOwn(state.episodes, { text: utterance, now, scope });
    else {
      closed = closeEpisode(state.episodes, {
        text: utterance,
        quote: event.quote,
        quoteOk: Boolean(event.quote) && utterance.includes(event.quote),
        now,
        scope,
      });
    }
    if (closed) state.repairHint = null;
    else if (event.quote) {
      state.repairHint = {
        text: String(utterance || '').slice(0, 40),
        at: round(now, 1),
        trust: 0,
        clingy: 0,
      };
    }
    episodeResult = {
      logged: Boolean(closed),
      why: closed ? 'repair:closed' : 'repair:unclear',
      type: '修复',
    };
  } else if (event.what) {
    if (event.type === '亲近') {
      episodeResult = noteGood(state.episodes, {
        what: event.what,
        emo: result.emo,
        scope,
        now,
        label,
        who: event.who,
      });
    } else if (event.who === '我' && ['挑刺', '失约', '冷落', '拒绝'].includes(event.type)) {
      episodeResult = noteOwn(state.episodes, {
        what: event.what,
        emo: result.emo,
        scope,
        now,
        label,
      });
    } else {
      episodeResult = markEpisode(state.episodes, {
        what: event.what,
        weight: event.weight,
        emo: result.emo,
        scope,
        now,
        unsolved: event.unsolved,
        label,
        who: event.who,
      });
    }
  } else {
    const salience = Math.abs(Number(result.delta?.valence || 0))
      + 8 * Number(result.surge?.level || 0)
      + 8 * Number(result.sting?.level || 0);
    episodeResult = observeEpisode(state.episodes, {
      etype: event.type,
      quote: event.quote,
      quoteOk: Boolean(event.quote) && utterance.includes(event.quote),
      salience,
      text: utterance,
      now,
      label,
      unsolved: event.unsolved,
      scope,
      msgId: envelope.eventId,
      emo: result.emo,
    });
  }
  if (episodeResult?.mult) repeat = Number(episodeResult.mult);
  else if (episodeResult?.state === stateBefore) repeat = repeatMult;
  return { episodeResult, repeat };
}

function applyLetGoAndEpisodeUpdate(state, result, now, scope) {
  // `ep.i` 指向观察员当时看到的那份心绪清单。先固定编号，再做 `let_go`
  // 关闭操作；否则放下一项会让后面的编号整体前移，最终处理错另一笔旧账。
  const scopedBucket = getBucket(state.episodes, scope);
  const numberedOpen = pullOpenItems({
    scopes: { [String(scope || '')]: scopedBucket },
  }, 20);
  const letGo = String(result.let_go || '').trim();
  if (letGo) {
    const target = normalizeEpisodeText(letGo);
    const bucket = getBucket(state.episodes, scope);
    const item = bucket.items.find((entry) => {
      if (!entry || entry.solved) return false;
      const quote = normalizeEpisodeText(entry.quote || '');
      return quote && (quote.includes(target) || target.includes(quote));
    });
    if (item) {
      item.solved = true;
      item.closed_at = now;
      item.closed_by = '她自己放下';
    }
  }

  const index = Number(result.ep?.i || 0);
  const action = String(result.ep?.state || '没问');
  if (!(index > 0) || !['问了', '他答了', '了了', '删了'].includes(action)) return;
  // `ep.i` 是当前关系 scope 的清单编号，不能拿所有用户的旧账合并排序。
  // 否则 scope A 的一条回复可能关掉 scope B 的事件。
  const open = numberedOpen[index - 1];
  if (!open) return;

  if (action === '问了' || action === '他答了') {
    noteEpisodeAsk(state.episodes, open.id, {
      note: result.ep.note,
      answered: action === '他答了',
      now,
      scope,
    });
  } else if (action === '了了') {
    open.solved = true;
    open.closed_at = now;
    open.closed_by = '她确认了了';
  } else if (action === '删了') {
    for (const bucket of Object.values(state.episodes.scopes || {})) {
      if (!Array.isArray(bucket.items)) continue;
      const at = bucket.items.findIndex((entry) => String(entry.id) === String(open.id));
      if (at >= 0) {
        bucket.items.splice(at, 1);
        break;
      }
    }
  }
  if (result.ep.label) {
    open.label = String(result.ep.label).slice(0, 12);
    open.label_at = now;
  }
}

function beatValence(result) {
  const beats = Array.isArray(result.beats) ? result.beats : [];
  if (beats.length < 2) return null;
  return Math.max(-35, Math.min(35, beats.reduce((sum, beat) => sum + Number(beat.v || 0), 0)));
}

function prepareDelta(result, repeat, options = {}) {
  const delta = { ...(result.delta || {}) };
  const total = beatValence(result);
  if (total !== null) delta.valence = total;

  const eventType = String(result.event?.type || '普通');
  const valence = Number(delta.valence || 0);
  if (!options.holdAnger && !result.burst && !result.beats?.length && eventType === '亲近' && valence < 6) {
    delta.valence = 6;
  } else if (
    !result.sting
    && !result.mask
    && !result.burst
    && !result.beats?.length
    && eventType === '普通'
    && valence > -4
    && valence < 0
  ) {
    delta.valence = 0;
  }

  if (result.mask && Number(delta.valence || 0) < 0) {
    const level = Math.max(1, Math.min(3, Number(result.mask.level || 1)));
    delta.valence = Math.max(-35, Number(delta.valence) * (1 + 0.10 * level));
    delta.arousal = Number(delta.arousal || 0) + 4 * level;
    delta.clingy = Number(delta.clingy || 0) - level;
  }

  const split = splitBurst({ ...result, delta });
  const out = split.delta;
  if (result.surge && !options.holdAnger) {
    const level = Math.max(1, Math.min(3, Number(result.surge.level || 1)));
    out.arousal = Number(out.arousal || 0) + 12 * level;
    out.valence = Number(out.valence || 0) + 5 * level;
    out.clingy = Number(out.clingy || 0) + 2 * level;
  }

  let stingLevel = result.sting
    ? Math.max(1, Math.min(3, Number(result.sting.level || 1)))
    : 0;
  let stingGain = result.sting ? 1 : 0.5;
  if (!stingLevel) {
    const value = Number(out.valence || 0);
    if (value <= -55) stingLevel = 2;
    else if (value <= -40) stingLevel = 1;
  }
  if (stingLevel) {
    out.arousal = Number(out.arousal || 0) + 10 * stingLevel * stingGain;
    out.valence = Number(out.valence || 0) - 4 * stingLevel * stingGain;
    out.clingy = Number(out.clingy || 0) - 2 * stingLevel * stingGain;
  }

  for (const key of Object.keys(out)) {
    let value = Number(out[key] || 0);
    if (value < 0 && repeat < 1) value *= repeat;
    out[key] = value;
  }
  if (options.holdAnger) {
    if (split.burst?.key === 'valence' && Number(split.burst.delta || 0) > 0) {
      out.valence = 0;
      split.burst.delta = 2;
    }
    out.valence = Math.min(Number(out.valence || 0), 2);
    out.clingy = Math.min(Number(out.clingy || 0), 1);
  }
  return { delta: out, burst: split.burst, stingFallback: !result.sting && stingLevel > 0 };
}

function putAxis(mood, key, amount, options = {}) {
  let raw = Number(amount || 0);
  if (!raw) return 0;
  const repeat = Number(options.repeat ?? 1);
  if (raw < 0 && repeat < 1) raw *= repeat;
  const ceiling = { arousal: 18, clingy: 18 }[key];
  if (ceiling && raw > ceiling && !options.burst) raw = ceiling;
  const field = key === 'clingy' ? 'cling_adj' : key;
  const current = Number(mood[field] || 0);
  if (raw > 0 && !options.burst) {
    if (key === 'arousal') {
      if (current >= 85) raw *= 0.2;
      else if (current >= 70) raw *= 0.5;
    } else if (key === 'clingy') {
      if (current >= 35) raw *= 0.35;
      else if (current >= 18) raw *= 0.7;
    }
  }
  if (key === 'valence' && raw > 22 && !options.burst) raw = 22;
  if (key === 'arousal' && raw > 0 && !options.burst) {
    raw = Math.min(raw, Math.max(0, 84 - Number(mood.arousal || 0)));
  }
  const next = clampAxis(key, current + raw);
  mood[field] = round(next, 2);
  return mood[field] - current;
}

function applySemanticDelta(state, result, repeat, now, options = {}) {
  const before = clone(state.mood);
  const { delta, burst, stingFallback } = prepareDelta(result, repeat, options);
  const real = {};
  for (const key of ['valence', 'arousal', 'clingy', 'dominance']) {
    real[key] = putAxis(state.mood, key, delta[key], { repeat, burst: false });
  }
  if (burst) {
    const key = burst.key === 'cling' ? 'clingy' : burst.key;
    if (['valence', 'arousal', 'clingy', 'dominance'].includes(key)) {
      real[key] = round((real[key] || 0) + putAxis(state.mood, key, burst.delta, { burst: true }), 2);
    }
  }
  state.mood.energy = Math.max(25, Number(state.mood.energy || 25));
  const impulse = round(Number(state.mood.valence || 0) - Number(before.valence || 0), 1);
  state.mood.last_impulse = impulse;
  if (impulse <= -26) {
    state.mood.hit = { drop: impulse, at: round(now, 1) };
  }

  if (result.mask) {
    state.emotion.mask = {
      ...result.mask,
      at: round(now, 1),
    };
  }
  if (result.surge && !options.holdAnger) {
    state.mood.surge = {
      kind: result.surge.kind,
      level: result.surge.level,
      at: round(now, 1),
    };
    state.emotion.surge = state.mood.surge;
  }
  if (result.sting || stingFallback) {
    state.mood.sting = {
      kind: result.sting?.kind || '按数值判定',
      level: result.sting?.level || Math.max(1, Math.min(3, Math.round(Math.abs(Number(delta.valence || 0)) / 20))),
      at: round(now, 1),
    };
    state.emotion.sting = state.mood.sting;
  }
  if (state.mood.hit) state.emotion.hit = state.mood.hit;

  state.mood.reg_cool = Math.max(0, Number(state.mood.reg_cool || 0)) + 1;
  const base = Number(state.mood.valence_base || 10);
  state.mood.neg_streak = Number(state.mood.valence || 0) <= base - 18
    ? Number(state.mood.neg_streak || 0) + 1
    : 0;

  const rebound = reboundRegulation(state.mood);
  state.mood = rebound.mood;
  const affinityRecord = state.affinity.users?.[state.scope];
  const strategy = options.holdAnger
    ? null
    : pickRegulation({
      v: Number(state.mood.valence || 0),
      arousal: Number(state.mood.arousal || 0),
      emo: result.emo,
      affinity: Number(affinityRecord?.score || 0),
      negativeStreak: Number(state.mood.neg_streak || 0),
      energy: Number(state.vitality.energy || 0),
      base,
      coolDown: Number(state.mood.reg_cool || 99),
    });
  let regulation = null;
  if (strategy) {
    state.mood.reg_cool = 0;
    const applied = applyRegulation(strategy, state.mood);
    state.mood = applied.mood;
    regulation = { strategy, summary: applied.summary };
  }

  const previousItems = Array.isArray(state.mood.extreme?.items) ? state.mood.extreme.items : [];
  const silence = now - Number(state.mood.last_user_msg_at || 0);
  const activePrevious = silence >= 6 * HOUR ? [] : previousItems;
  const lastEntered = state.mood.extreme?.entered_at || {};
  const items = detectExtremes({
    valence: state.mood.valence,
    energy: state.mood.energy,
    vitality: state.vitality.energy,
    clingy: state.mood.cling_adj,
    arousal: state.mood.arousal,
  }, {
    sting: Boolean(result.sting || stingFallback),
    surge: Boolean(result.surge),
    event: result.event?.type || '',
    impulse,
    now,
  }, activePrevious, lastEntered);
  const enteredAt = { ...lastEntered };
  for (const item of items) {
    if (!item.locked) enteredAt[item.key] = round(now, 1);
  }
  const previousKeys = new Set((state.mood.extreme?.keys || []).map(String));
  const newItems = items.filter((item) => !previousKeys.has(String(item.key)));
  state.mood.extreme = {
    items,
    keys: items.map((item) => String(item.key)),
    new_items: newItems,
    label: extremeSnapshotLabel(items),
    new_label: extremeSnapshotLabel(newItems),
    at: round(now, 1),
    entered_at: enteredAt,
  };
  state.mood.burst_mode = items.length > 0;
  state.mood.calc_last = {
    at: round(now, 1),
    before: {
      valence: round(before.valence, 1),
      arousal: round(before.arousal, 1),
      clingy: round(Number(before.cling_adj || 0) + 35, 1),
      dominance: round(before.dominance, 1),
    },
    after: {
      valence: round(state.mood.valence, 1),
      arousal: round(state.mood.arousal, 1),
      clingy: round(Number(state.mood.cling_adj || 0) + 35, 1),
      dominance: round(state.mood.dominance, 1),
    },
    burst,
    regulation,
  };
  state.mood.last_emo = String(result.emo || '');
  return { real, impulse, regulation, burst };
}

const ANGER_WORD = /(气|火|怒|恼|烦|顶|炸|刺|冷|硬|不服|没消|账|牙)/;
const SOFT_ANGER_WORD = /(哄|软|甜|羞|臊|心动|撒娇|乖|抱|求|委屈|想哭|可怜|可爱)/;
const FEELING_ANCHOR_SECONDS = 30 * 60;
const FEELING_ANCHOR_SCORE_FLOOR = 0.08;
const FEELING_ANCHOR_STRONG_SHIFT = 18;

function cleanFeeling(word) {
  return String(word || '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

function previousFeelingAnchor(previous) {
  const word = cleanFeeling(previous?.anchor?.word || previous?.feelings?.[0]);
  if (!word) return null;
  const recordedAt = Number(previous?.anchor?.at || 0);
  const fallbackAt = Number(previous?.at || 0);
  return {
    word,
    at: recordedAt > 0 ? recordedAt : fallbackAt,
    source: String(previous?.anchor?.source || 'recent'),
  };
}

function heldAngerExpression(result, previous) {
  const next = Array.isArray(result.feelings) ? result.feelings : [];
  const old = Array.isArray(previous?.feelings) ? previous.feelings : [];
  const clean = (word) => String(word || '').replace(/\s+/g, ' ').trim().slice(0, 12);
  const keep = (word) => ANGER_WORD.test(clean(word)) && !SOFT_ANGER_WORD.test(clean(word));
  const anger = [...new Set([...next.filter(keep), ...old.filter(keep)].map(clean).filter(Boolean))];
  const nuance = [...new Set(next.map(clean).filter((word) => (
    word && !anger.includes(word) && !SOFT_ANGER_WORD.test(word) && !ANGER_WORD.test(word)
  )))];
  const feelings = [...new Set([
    anger[0] || '火还没消',
    nuance[0] || anger[1] || '这事没过去',
    nuance[1] || anger[2] || '这事没过去',
  ])].slice(0, 3);

  const nextEmo = String(result.emo || '').trim();
  const oldEmo = String(previous?.emo || '').trim();
  const emo = keep(nextEmo)
    ? nextEmo
    : keep(oldEmo)
      ? oldEmo
      : '还在生气';
  return { feelings, emo, nuance: nuance[0] || '' };
}

function selectStableFeelings(previous, incoming, labels, options = {}) {
  const clean = cleanFeeling;
  const old = [...new Set((Array.isArray(previous?.feelings) ? previous.feelings : []).map(clean).filter(Boolean))];
  const next = [...new Set((Array.isArray(incoming) ? incoming : []).map(clean).filter(Boolean))];
  const scores = labels && typeof labels === 'object' ? labels : {};
  const score = (word) => Number(scores[word] || 0);
  const ranked = Object.keys(scores)
    .map(clean)
    .filter(Boolean)
    .sort((a, b) => score(b) - score(a));
  const angerOnly = (word) => ANGER_WORD.test(clean(word)) && !SOFT_ANGER_WORD.test(clean(word));
  const now = Math.max(0, Number(options.now || 0));
  const priorAnchor = previousFeelingAnchor(previous);
  const anchorAge = priorAnchor && now >= priorAnchor.at
    ? now - priorAnchor.at
    : Number.POSITIVE_INFINITY;
  const recentAnchorFits = Boolean(
    priorAnchor
    && anchorAge <= FEELING_ANCHOR_SECONDS
    && score(priorAnchor.word) >= FEELING_ANCHOR_SCORE_FLOOR
  );
  const strongShift = Boolean(options.forceAnchorChange)
    || Math.abs(Number(options.valenceShift || 0)) >= FEELING_ANCHOR_STRONG_SHIFT;
  let anchor = '';
  let carried = false;
  let anchorAt = now;
  let anchorSource = 'fresh';

  if (options.angerHeld) {
    const priorPrimary = priorAnchor?.word && angerOnly(priorAnchor.word) ? priorAnchor.word : old[0] || '';
    if (priorPrimary && angerOnly(priorPrimary) && score(priorPrimary) >= 0.06) {
      anchor = priorPrimary;
      anchorAt = priorAnchor?.word === priorPrimary ? priorAnchor.at : now;
      carried = true;
    } else {
      anchor = ranked.find((word) => angerOnly(word) && score(word) >= 0.06)
        || old.find(angerOnly)
        || next.find(angerOnly)
        || '火还没消';
      carried = old.includes(anchor) || old.some(angerOnly);
    }
    anchorSource = 'anger';
  }

  if (!anchor && recentAnchorFits && !strongShift) {
    anchor = priorAnchor.word;
    anchorAt = priorAnchor.at;
    anchorSource = priorAnchor.source || 'recent';
    carried = true;
  }
  if (!anchor) {
    // 到点或发生强反转时，本轮新观察优先成为下一段锚点。只有本轮没有
    // 新词时，才借用其他仍有分量的旧词；不能把刚过期的旧锚点原地续上。
    anchor = next[0]
      || clean(options.currentEmo)
      || ranked.find((word) => word !== priorAnchor?.word)
      || old.find((word) => word !== priorAnchor?.word)
      || '';
    anchorAt = now;
    anchorSource = 'fresh';
    carried = false;
  }

  let second = options.preferredSecond && options.preferredSecond !== anchor
    ? options.preferredSecond
    : next.find((word) => word !== anchor);
  if (!second) second = old.find((word) => word !== anchor && score(word) >= 0.05);
  if (!second) second = ranked.find((word) => word !== anchor && score(word) >= 0.05);
  let third = next.find((word) => word !== anchor && word !== second);
  if (!third) third = old.find((word) => word !== anchor && word !== second && score(word) >= 0.05);
  if (!third) third = ranked.find((word) => word !== anchor && word !== second && score(word) >= 0.05);
  const feelings = [...new Set([anchor, second, third].filter(Boolean))].slice(0, 3);
  return {
    feelings,
    carried,
    changed: Boolean(priorAnchor && anchor && anchor !== priorAnchor.word),
    anchor: anchor ? {
      word: anchor,
      at: round(anchorAt || now, 1),
      source: anchorSource,
    } : null,
  };
}

function reinforceHeldAnger(mood) {
  const pad = mood?.pad;
  if (!pad || typeof pad !== 'object') return;
  pad.labels = pad.labels && typeof pad.labels === 'object' ? pad.labels : {};
  for (const word of Object.keys(pad.labels)) {
    if (SOFT_ANGER_WORD.test(word) || /被哄到一半/.test(word)) delete pad.labels[word];
  }
  const hasAngerLabel = Object.entries(pad.labels)
    .some(([word, value]) => ANGER_WORD.test(word) && !SOFT_ANGER_WORD.test(word) && Number(value) >= 0.2);
  if (!hasAngerLabel) pad.labels['火还没消'] = Math.max(0.5, Number(pad.labels['火还没消'] || 0));
}

function updateExpression(state, result, envelope, event, now, previousRepeat, options = {}) {
  const previous = state.emotion || {};
  const selected = selectStableFeelings(
    previous,
    result.feelings,
    state.mood?.pad?.labels,
    {
      now,
      angerHeld: options.angerHeld,
      preferredSecond: options.preferredSecond,
      currentEmo: result.emo,
      valenceShift: options.valenceShift,
      forceAnchorChange: reparativeEvent(event?.type),
    }
  );
  const selectedFeelings = selected.feelings;
  const requestedEmo = String(result.emo || '').trim();
  const oldEmo = String(previous.emo || '').trim();
  const emo = selectedFeelings.includes(requestedEmo)
    ? requestedEmo
    : selectedFeelings.includes(oldEmo)
      ? oldEmo
      : selectedFeelings[0] || requestedEmo;
  const feelLinks = (Array.isArray(result.feelLinks) ? result.feelLinks : [])
    .filter((item) => item && selectedFeelings.includes(String(item.w || '')))
    .slice(0, 3);
  const body = String(result.body || '').trim().slice(0, 14);
  state.emotion = {
    ...state.emotion,
    feelings: selectedFeelings,
    feelLinks,
    emo,
    mood: String(result.mood || '').slice(0, 60),
    state: String(result.state || '').slice(0, 1200),
    read: String(result.read || '').slice(0, 80),
    why: String(result.why || '').slice(0, 60),
    body,
    carry: selected.carried
      ? '沿用'
      : selected.changed
        ? '变了'
        : String(result.carry || ''),
    anchor: selected.anchor,
    letGo: String(result.let_go || '').slice(0, 24),
    at: round(now, 1),
    surge: state.mood.surge || null,
    sting: state.mood.sting || null,
    mask: state.emotion.mask || null,
    hit: state.mood.hit || null,
  };
  state.lastEvent = {
    eventId: String(envelope.eventId || ''),
    type: event.type,
    quote: event.quote,
    what: event.what,
    label: event.label,
    who: event.who,
    weight: event.weight,
    unsolved: event.unsolved,
  };
  state.lastAction = {
    act: result.act || '',
    model: result.act || '',
    type: event.type,
    downgraded: false,
    at: round(now, 1),
    repeat: previousRepeat,
  };
}

function updateSlowRelationship(state, result, now, scope) {
  const trust = refreshTrust(state.mood, state.episodes, scope, now);
  state.mood = trust.mood;
  const old = state.judgement;
  const update = shouldUpdateJudgement(
    old,
    result.judge,
    Number(state.mood.trust || 0),
    Number(state.mood.cling_adj || 0) + 35
  );
  if (update.update && result.judge) {
    state.judgement = {
      text: String(result.judge).slice(0, 40),
      at: round(now, 1),
      trust: round(state.mood.trust, 2),
      clingy: round(Number(state.mood.cling_adj || 0) + 35, 2),
    };
  }
  state.judgementLast = {
    text: String(result.judge || '').slice(0, 40),
    update: Boolean(update.update),
    reason: String(update.reason || '').slice(0, 80),
    drift: round(update.drift || 0, 2),
    at: round(now, 1),
    trust: round(state.mood.trust, 2),
    clingy: round(Number(state.mood.cling_adj || 0) + 35, 2),
  };
}

function companionInterpretationLines(value) {
  if (!isObject(value)) return '';
  const read = String(value.read || '').trim().slice(0, 80);
  const monologue = String(value.monologue || '').trim().slice(0, 220);
  const lines = [];
  if (read) lines.push(`小模型读成：${read}`);
  if (monologue) lines.push(`她此刻的心里话：${monologue}`);
  if (!lines.length) return '';
  return [
    ...lines,
    '这些只是这一轮的私下读法和语气参考，不是台词；不要照抄，也不要解释。若与他的原话、事件或动作证据冲突，按证据来。',
  ].join('\n');
}

/**
 * 组织给陪伴会话的受控上下文。返回的 blocks 不含数值、系统字段或身份键。
 *
 * @param {object} input 第 2 层状态，会被就地更新少量注入冷却字段。
 * @param {object} options
 * @returns {{state: object, blocks: string[]}}
 */
export function buildLayer2Context(input, options = {}) {
  const state = isObject(input) ? input : createDefaultLayer2State();
  const now = unixSeconds(options.now);
  const scope = String(options.scope || state.scope || 'default');
  const text = String(options.currentText || '');
  const safety = Boolean(options.safety) || Boolean(crisisHit(text));
  if (safety) {
    state.context.lastInjectionAt = round(now, 1);
    return { state, blocks: [crisisLine(text)].filter(Boolean) };
  }

  // Reserving the unseen local activity first prevents the general context cap
  // from marking it consumed and then dropping the same line before the model
  // ever sees it.
  const localActivity = consumeLocalActivityLine(state.background, now);
  const blocks = localActivity ? [localActivity] : [];
  const core = formatCoreMemory(state.coreMemory);
  if (core) blocks.push(core);
  if (options.companion === true) {
    state.context.lastInjectionAt = round(now, 1);
    return {
      state,
      blocks: companionContextBlocks({
        state,
        scope,
        currentText: text,
        now,
        seedBlocks: blocks,
        random: options.random || (() => 0),
        interpretations: options.interpretations,
      }),
    };
  }

  const expression = state.emotion || {};
  const view = moodView(state.mood, now);
  const feelingMood = {
    ...state.mood,
    valence: view.valence,
    energy: view.energy,
    arousal: view.arousal,
    dominance: view.dominance,
    clingy: view.clinginess,
    trust: view.trust,
    mask: expression.mask || null,
    surge: expression.surge || null,
    sting: expression.sting || null,
  };
  blocks.push(describeFeelings(feelingMood, state.vitality, '', undefined, 4, now));

  const expressionView = expressionReactionText(expression, null);
  if (expressionView) blocks.push(`【她这一轮留下的观察】${expressionView}`);
  const top = topLabel(state.mood);
  if (top.score >= 0.12 && top.name) {
    const hint = emotionHint(state.mood);
    blocks.push(`【情绪余味】刚才那股「${top.name}」还在；${hint || '它只影响语气，不影响你判断，也不影响你手上要做的事。'}`);
  }
  const regulation = unresolvedAnger(state.mood, state.emotion, now) && !reparativeEvent(state.lastEvent?.type)
    ? ''
    : regulationLines(state.mood, now);
  if (regulation) blocks.push(regulation);
  if (state.lastAction?.act) blocks.push(actionLine(state.lastAction.act));
  if (state.mood.extreme?.label) {
    blocks.push(`【极端状态】你现在正处在：${state.mood.extreme.label}。这股劲是真的，别装作没事，也别解释。`);
  }
  const judgement = judgementLine(state.judgement);
  if (judgement) blocks.push(judgement);

  const promise = renderPromises(state.promises, now);
  if (promise) blocks.push(promise);
  const open = openEpisodeLine(state.episodes, scope);
  if (open) blocks.push(`【她心里挂着的事】${open}`);
  const good = goodEpisodes(state.episodes, scope, now, 14, 2);
  if (good.length) {
    blocks.push(`【她还记着他的好】${good.map((item) => `「${String(item.quote || '').slice(0, 40)}」`).join('；')}`);
  }
  const repair = repairHintLine(state.repairHint, now);
  if (repair) {
    blocks.push(repair);
    state.repairHint.asked_at = round(now, 1);
  }

  const inner = innerLifeBlocks(state.inner, now, text);
  blocks.push(...inner.blocks);

  const vitality = renderVitality(state.vitality, now);
  if (vitality) blocks.push(vitality);
  const body = renderInteroception(state.vitality, state.mood, now);
  if (body) blocks.push(body);
  const hard = hardDirective(
    state.vitality,
    state.mood,
    now,
    text,
    state.inner.scars || [],
    state.lastEvent?.type || ''
  );
  if (hard) blocks.push(hard);

  const conflict = renderConflict(
    state.conflict,
    state.vitality,
    feelingMood,
    false,
    now,
    options.random || (() => 0)
  );
  if (conflict) blocks.push(conflict);

  const relation = relationFrom(state.affinity, state.episodes, state.inner, state.promises, now, scope);
  const recentTexts = [text, ...(state.context.recent || []).slice(-5).map((item) => item.t).reverse()]
    .filter(Boolean);
  const tags = detectTags(recentTexts, now);
  const composite = compositeEmotion(
    { ...view, clingy: view.clinginess },
    state.vitality,
    state.mood,
    tags,
    relation,
    now,
    null,
    options.random || (() => 0),
    { eventType: state.lastEvent?.type || '' }
  );
  if (composite.feel) blocks.push(`【复合心情】${composite.feel}${composite.want || ''}`);

  const background = backgroundLine(state.background);
  if (background) blocks.push(`【她自己的日子】${background}`);
  // 规矩本在旧活路径中已停用；不能因为状态里还留着历史规则就重新注入。

  const epiphany = renderEpiphany(state.vitality, now);
  if (epiphany) {
    blocks.push(epiphany);
    const item = pendingEpiphany(state.vitality, now);
    if (item) markEpiphanyUsed(state.vitality, item.id);
  }

  state.context.lastInjectionAt = round(now, 1);
  return { state, blocks: dedupeAndCap(blocks) };
}

function companionReplyCue(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (/(你是谁|你叫什么|你是什么|你是哪位|介绍一下你)/.test(value)) {
    return '她像被主人突然查户口，先露出一点意外，再自然回答；一两句就够，不背身份卡，也不重新报一遍爱好和住处。';
  }
  if (/^(在吗|在不在|在么|你好|嗨|哈喽|hi|hello|早上好|早安|晚安)[啊呀呢嘛吗。.!！?？~～…]*$/i.test(value)) {
    return '主人只是叫了一声，先应他；别趁机做自我介绍，也别为了填空白硬塞“我刚在做什么”。';
  }
  if (/(怎么办|为什么|怎么弄|能不能|帮我|解释|说说|怎么看)/.test(value)) {
    return '先把主人这句话接住，再按需要给判断或办法；认真问题就把玩笑收一点，不要把回答整理成客服清单。';
  }
  if (/(难受|想哭|崩溃|害怕|好累|撑不住|疼|不开心|委屈)/.test(value)) {
    return '先停下来听清楚他的情绪，别急着讲道理或逗他；关系再熟也不拿难过开玩笑。';
  }
  return '';
}

function expressionReactionText(expression, judgement) {
  const parts = [];
  const feelings = Array.isArray(expression?.feelings)
    ? expression.feelings
      .map((word) => String(word || '').trim())
      .filter(Boolean)
      .slice(0, 3)
    : [];
  if (feelings.length) {
    parts.push(`她给这股劲起的名字是「${feelings.join('、')}」`);
  }
  const emo = String(expression?.emo || '').trim();
  if (emo && emo !== '空' && !feelings.includes(emo)) {
    parts.push(`主调是「${emo}」`);
  }

  const carry = String(expression?.carry || '').trim();
  if (carry === '沿用') parts.push('上一轮那股劲还在');
  else if (carry === '变了') parts.push('上一轮那股劲已经被这一轮改掉了');

  const judgementText = String(judgement?.text || '').trim().slice(0, 40);
  if (judgementText) parts.push(`她心里对他的看法是「${judgementText}」`);
  return parts.join('；');
}

function sentencePart(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  return /[。！？!?]$/.test(value) ? value : `${value}。`;
}

function joinReactionSentences(parts) {
  return parts.map(sentencePart).filter(Boolean).join('');
}

function companionExtremeBlock(extreme) {
  const source = isObject(extreme) ? extreme : {};
  const items = Array.isArray(source.items) ? source.items : [];
  const details = items
    .filter(isObject)
    .map((item) => {
      const label = String(item.label || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      const directive = String(item.directive || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 650);
      if (!directive) return '';
      return label ? `${label}：${directive}` : directive;
    })
    .filter(Boolean)
    .slice(0, 5);

  if (details.length) {
    return [
      '【爆发态：她现在真的压不住】',
      ...details,
      '别向主人报状态名或解释设定；把这股劲直接落到这一轮的称呼、追问、停顿和句尾。',
    ].join('\n');
  }

  const label = String(source.label || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!label) return '';
  return `【她现在真的压不住】${label}。这股劲会直接影响语气，别装作没事。`;
}

/**
 * 陪伴聊天只接收观察结果和程序派生的状态，不接收小模型预写的内心戏。
 * 大模型直接读原话与最近对话，再根据这些事实自己决定怎么理解和回答。
 */
function companionContextBlocks({
  state,
  scope,
  currentText,
  now,
  seedBlocks,
  random,
  interpretations,
}) {
  // Current-turn facts and hard constraints get their own priority lane.
  // Memory and ambient life can add colour, but must never push them past the
  // ten-block budget before the large model ever reads them.
  const primary = [...(Array.isArray(seedBlocks) ? seedBlocks : [])];
  const blocks = [];
  const expression = state.emotion || {};
  const view = moodView(state.mood, now);
  const feelingMood = {
    ...state.mood,
    valence: view.valence,
    energy: view.energy,
    arousal: view.arousal,
    dominance: view.dominance,
    clingy: view.clinginess,
    trust: view.trust,
    mask: expression.mask || null,
    surge: expression.surge || null,
    sting: expression.sting || null,
  };

  const cue = companionReplyCue(currentText);
  if (cue) primary.push(`【这一下怎么接】${cue}`);

  const reaction = [];
  const felt = describeFeelings(
    feelingMood,
    state.vitality,
    '',
    undefined,
    2,
    now
  ).replace(/^【她此刻】/, '').replace(/。$/u, '');
  if (felt) reaction.push(felt);
  const judged = expressionReactionText(expression, state.judgement);
  if (judged) reaction.push(judged);
  const interpretation = companionInterpretationLines(interpretations);
  if (reaction.length || interpretation) {
    const observed = joinReactionSentences(reaction);
    primary.push([
      '【她这一轮的状态观察，不是台词】',
      observed,
      interpretation,
    ].filter(Boolean).join('\n'));
  }

  const action = actionLine(state.lastAction?.act);
  if (action) primary.push(action);
  const extreme = companionExtremeBlock(state.mood.extreme);
  if (extreme) primary.push(extreme);
  const regulation = unresolvedAnger(state.mood, state.emotion, now) && !reparativeEvent(state.lastEvent?.type)
    ? ''
    : regulationLines(state.mood, now);
  if (regulation) blocks.push(regulation);

  const promise = renderPromises(state.promises, now);
  if (promise) blocks.push(promise);
  const open = openEpisodeLine(state.episodes, scope);
  if (open) blocks.push(`【她心里挂着的事】${open}`);
  const good = goodEpisodes(state.episodes, scope, now, 14, 1);
  if (good.length) {
    blocks.push(`【她还记着他的好】「${String(good[0].quote || '').slice(0, 40)}」`);
  }
  const repair = repairHintLine(state.repairHint, now);
  if (repair) {
    blocks.push(repair);
    state.repairHint.asked_at = round(now, 1);
  }
  const inner = innerLifeBlocks(state.inner, now, currentText);
  blocks.push(...inner.blocks);

  const energy = Number(state.vitality?.energy ?? state.mood?.energy ?? 65);
  if (energy <= 50 || energy >= 85) {
    const vitality = renderVitality(state.vitality, now);
    if (vitality) blocks.push(vitality);
  }
  const body = renderInteroception(state.vitality, state.mood, now);
  if (body) blocks.push(body);
  const hard = hardDirective(
    state.vitality,
    state.mood,
    now,
    currentText,
    state.inner.scars || [],
    state.lastEvent?.type || ''
  );
  if (hard) primary.push(hard);

  const conflict = renderConflict(
    state.conflict,
    state.vitality,
    feelingMood,
    false,
    now,
    random
  );
  if (conflict) blocks.push(conflict);

  const relation = relationFrom(
    state.affinity,
    state.episodes,
    state.inner,
    state.promises,
    now,
    scope
  );
  const recentTexts = [
    currentText,
    ...(state.context.recent || []).slice(-5).map((item) => item.t).reverse(),
  ].filter(Boolean);
  const tags = detectTags(recentTexts, now);
  const composite = compositeEmotion(
    { ...view, clingy: view.clinginess },
    state.vitality,
    state.mood,
    tags,
    relation,
    now,
    null,
    random,
    { eventType: state.lastEvent?.type || '' }
  );
  if (composite.feel) {
    blocks.push(`【她心里冒出来的劲】${composite.feel}${composite.want || ''}`);
  }

  const background = backgroundLine(state.background);
  if (background) blocks.push(`【她自己的日子】${background}`);
  const epiphany = renderEpiphany(state.vitality, now);
  if (epiphany) {
    blocks.push(epiphany);
    const item = pendingEpiphany(state.vitality, now);
    if (item) markEpiphanyUsed(state.vitality, item.id);
  }
  return dedupeAndCap([...primary, ...blocks], 10);
}

function dedupeAndCap(blocks, maxBlocks = 14) {
  const seen = new Set();
  const out = [];
  let used = 0;
  for (const raw of blocks) {
    const block = String(raw || '').trim();
    if (!block) continue;
    const key = block.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    if (out.length >= maxBlocks || used + block.length > 8000) break;
    seen.add(key);
    out.push(block);
    used += block.length;
  }
  return out;
}

/**
 * 只读、脱敏的第 2 层视图。刻意不含分数、actor id、eventId 和原始私密文本。
 *
 * @param {object} input
 * @param {number} [now]
 * @returns {object}
 */
export function layer2View(input, now = Date.now()) {
  const state = isObject(input) ? input : createDefaultLayer2State();
  const seconds = unixSeconds(now);
  const view = moodView(state.mood, seconds);
  const open = Object.values(state.episodes.scopes || {})
    .flatMap((bucket) => Array.isArray(bucket.items) ? bucket.items : [])
    .filter((item) => item && !item.solved && !item.closed_by);
  return {
    feelings: Array.isArray(state.emotion.feelings) ? state.emotion.feelings : [],
    emo: state.emotion.emo || '',
    mood: state.emotion.mood || '',
    state: state.emotion.state || '',
    labels: {
      valence: view.valence <= -40 ? '很差' : view.valence <= -10 ? '不太好' : view.valence < 20 ? '平静' : view.valence < 50 ? '不错' : '很好',
      energy: view.energy < 20 ? '快没电了' : view.energy < 45 ? '有点累' : view.energy < 75 ? '正常' : '精神',
      arousal: view.arousal >= 50 ? '很激动' : view.arousal >= 20 ? '有点上头' : view.arousal <= -40 ? '很安静' : '平常',
      clinginess: view.clinginess >= 75 ? '很想被理' : view.clinginess >= 50 ? '有点黏' : '正常',
    },
    extreme: state.mood.extreme?.label || '',
    hasOpenEpisode: open.length > 0,
    openEpisodeCount: open.length,
    hasJudgement: Boolean(state.judgement?.text),
    background: backgroundLine(state.background),
    updatedAt: Number(state.updatedAt || 0),
  };
}

/**
 * 投影一次完整判读。返回的 state 必须整份提交；不要在调用方逐文件写入。
 *
 * @param {object} input 当前第 2 层状态。
 * @param {object} result `normalizeJudgeResult()` 的结果。
 * @param {object} envelope 判读信封。
 * @param {{now?: number, random?: () => number}} [options]
 * @returns {{state: object, context: string[], view: object, effects: object}}
 */
export function applyJudgeResult(input, result, envelope = {}, options = {}) {
  if (!isObject(input) || !isObject(result)) throw new TypeError('layer2 input required');
  const state = clone(input);
  const now = unixSeconds(options.now);
  const utterance = typeof envelope.input?.utterance === 'string' ? envelope.input.utterance : '';

  // 安全线必须比所有角色状态更早。即使调用方绕过 Host 的安全短路直接调用投影器，
  // 危机输入也不能推进心情、关系、旧账、体力或上下文。
  if (crisisHit(utterance)) {
    return {
      state,
      context: [crisisLine(utterance)],
      view: layer2View(state, now * 1000),
      effects: { crisis: true, changed: false, blocked: false },
    };
  }

  const scope = scopeFromEnvelope(envelope);
  seedRelationshipContinuity(state, scope, envelope.legacyRelationshipRef || state.scope);
  const actorName = actorNameFromEnvelope(envelope);
  state.scope = scope;
  state.actorName = actorName || state.actorName || '';
  state.channel = String(envelope.channel || '');

  pushContext(state, envelope, utterance, now);
  state.mood = applyMessage(
    state.mood,
    now,
    utterance,
    {
      isGroup: envelope.input?.isGroup === true || envelope.source?.isGroup === true,
      textDriven: false,
    }
  );
  const affinity = updateAffinity(state, scope, state.actorName, result.bond, now);
  captureTextRules(state, utterance, now, scope, envelope.input?.isOwner !== false);

  const refreshed = refreshVitality(state.vitality, now);
  state.vitality = refreshed.state;
  state.vitality.energy = Math.max(0, Math.min(100, Number(state.mood.energy || 0)));
  const hot = Boolean(result.surge || result.sting || Math.abs(Number(state.mood.valence || 0)) >= 40);
  const gate = gateVitality(
    state.vitality,
    now,
    utterance,
    envelope.input?.isOwner !== false,
    hot,
    options.random || (() => 0.5)
  );
  state.vitality = gate.state;
  if (gate.block) {
    state.mood.energy = Math.max(0, Math.min(100, Number(state.vitality.energy || 0)));
    state.updatedAt = now;
    state.lastEventId = String(envelope.eventId || '');
    const built = buildLayer2Context(state, {
      now,
      scope,
      currentText: utterance,
      random: options.random,
      companion: envelope.channel === 'chat',
      interpretations: {
        read: result.read,
        monologue: result.monologue,
      },
    });
    return {
      state: built.state,
      context: built.blocks,
      view: layer2View(built.state, now * 1000),
      effects: { gate, affinity, blocked: true },
    };
  }
  const spent = spendVitality(
    state.vitality,
    now,
    utterance,
    envelope.input?.hasImage === true || envelope.source?.hasImage === true
  );
  state.vitality = spent.state;
  state.mood.energy = Math.max(0, Math.min(100, Number(state.vitality.energy || 0)));

  const decided = decideEvent(result.event?.type, result.event?.quote, utterance);
  const event = {
    type: decided.type || '普通',
    quote: decided.quote || '',
    what: String(result.event?.what || '').slice(0, 60),
    label: String(result.event?.label || '').slice(0, 12),
    who: result.event?.who === '我' ? '我' : '他',
    weight: Math.max(0, Math.min(10, Number(result.event?.weight || 0))),
    unsolved: decided.type !== result.event?.type ? true : result.event?.unsolved !== false,
  };
  const episode = applyEpisodeResult(state, result, envelope, event, utterance, now, scope, 1);
  applyLetGoAndEpisodeUpdate(state, result, now, scope);

  const holdAnger = unresolvedAnger(state.mood, state.emotion, now) && !reparativeEvent(event.type);
  const semantic = applySemanticDelta(state, result, episode.repeat, now, { holdAnger });
  const intensity = Math.max(
    Math.min(1, Math.abs(Number(result.delta?.valence || 0)) / 35),
    Math.min(1, Math.abs(Number(result.delta?.arousal || 0)) / 30),
    0.1
  );
  const angerNow = unresolvedAnger(state.mood, state.emotion, now) && !reparativeEvent(event.type);
  const held = angerNow ? heldAngerExpression(result, state.emotion) : null;
  // 自由情绪词只记“她给这股劲起的名字”，不参与六轴的衰减刑期。
  // PAD 只是短时余味，用来在后续轮次里保留说话口气。
  state.mood = touchEmotion(state.mood, {
    feelings: held?.feelings || (Array.isArray(result.feelings) ? result.feelings : []),
    trigger: event.what || String(result.emo || ''),
    at: now,
    intensity: held ? Math.max(0.62, intensity) : intensity,
  });
  if (held) reinforceHeldAnger(state.mood);
  if (reparativeEvent(event.type)) state.mood = sootheEmotion(state.mood, now);
  const expressionResult = held
    ? { ...result, feelings: held.feelings, emo: held.emo, feelLinks: [] }
    : result;
  updateExpression(state, expressionResult, envelope, event, now, episode.repeat, {
    angerHeld: angerNow,
    preferredSecond: held?.nuance || '',
    valenceShift: semantic.real?.valence,
  });
  updateSlowRelationship(state, result, now, scope);

  state.mood.energy = Math.max(0, Math.min(100, Number(state.mood.energy || 0)));
  state.vitality.energy = state.mood.energy;
  state.updatedAt = now;
  state.lastEventId = String(envelope.eventId || '');
  const built = buildLayer2Context(state, {
    now,
    scope,
    currentText: utterance,
    random: options.random,
    companion: envelope.channel === 'chat',
    interpretations: {
      read: result.read,
      monologue: result.monologue,
    },
  });
  const finalView = layer2View(built.state, now * 1000);
  return {
    state: built.state,
    context: built.blocks,
    view: finalView,
    effects: {
      gate,
      spent: spent.cost,
      affinity,
      episode: episode.episodeResult,
      semantic,
      blocked: false,
    },
  };
}

/**
 * 后台生活的一次显式 tick。传 `dryRun:false` 且提供 `call` 时才允许模型产生内容；
 * Layer 2 默认只试算，不碰外部模型。
 *
 * @param {object} input 当前第 2 层状态。
 * @param {object} options
 * @returns {{state: object, record: object}}
 */
export async function runLayer2Background(input, options = {}) {
  const state = clone(isObject(input) ? input : createDefaultLayer2State());
  const now = unixSeconds(options.now);
  const lastUserAt = toUnixSeconds(
    options.lastUserAt ?? state.mood.last_user_msg_at ?? 0
  );
  state.background ||= createBackgroundState();
  const passId = String(options.passId || '').trim();
  if (passId && state.background.last_pass_id === passId) {
    return {
      state,
      record: {
        ok: true,
        duplicate: true,
        passId,
        why: '这一轮后台已经处理过',
        did: [],
        dry: options.dryRun !== false,
      },
      duplicate: true,
    };
  }
  const open = pullOpenItems(state.episodes, 8);
  const configuredEnergy = options.energy ?? state.vitality.energy ?? state.mood.energy ?? 65;
  const energy = Number.isFinite(Number(configuredEnergy)) ? Number(configuredEnergy) : 65;
  const record = await runBackgroundPass(
    state.background,
    now,
    options.dryRun === false ? (options.call || null) : null,
    {
      dryRun: options.dryRun !== false,
      lastUserAt,
      openItems: open,
      energy,
      pickTask: options.pickTask || (() => null),
      inner: state.emotion.state || '',
      awakeGap: options.awakeGap,
    }
  );
  if (!record.ok) {
    return { state: clone(input), record, duplicate: false };
  }
  state.updatedAt = now;
  if (passId) state.background.last_pass_id = passId;
  return { state, record, duplicate: false };
}
