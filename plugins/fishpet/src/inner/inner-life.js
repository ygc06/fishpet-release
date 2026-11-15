/**
 * 内里生活：没说完的缺口、梦的材料、明确要求别再提的疤痕。
 *
 * @module dsh-fishpet-emotion/inner/inner-life
 */

export const GAP_MARKER = '【还没说完的事】';
export const SCAR_MARKER = '【疤痕】';

export const GAP_MARKERS = Object.freeze([
  '下次再说', '回头再说', '回头聊', '晚点说', '晚点聊', '待会再说', '改天再说',
  '改天聊', '下次继续', '以后再说', '先这样', '先不聊了', '先睡了', '明天再说',
  '我去忙', '先撤了', '回头再聊', '有空再说', '先不说了', '不聊了',
]);

export const GAP_KEEP = 12;
export const GAP_TTL = 7 * 86400;
export const SCAR_KEEP = 8;
export const SCAR_TTL = 60 * 86400;
export const GAP_INJECT_COOLDOWN = 2 * 3600;
export const SHARE_MIN_GAP_AGE = 4 * 3600;
export const SHARE_MIN_SILENCE = 2 * 3600;
export const SHARE_MIN_INTERVAL = 6 * 3600;
export const SHARE_CHANCE = 0.45;
export const SHARE_START_HOUR = 9;
export const SHARE_END_HOUR = 23;
export const SHARE_GAP_COOLDOWN = 3 * 86400;

const SCAR_PATTERNS = Object.freeze([
  /别再(?:提|说|问|拿)(.{2,20}?)(?:了|吧|啊|的事)?[。！!？?…]*$/,
  /不许(?:再)?(?:提|说|问)(.{2,20}?)[。！!？?…]*$/,
  /不要(?:再)?(?:提|说|问)(.{2,18}?)[。！!？?…]*$/,
  /以后(?:别|不要|不准|不许)(?:再)?(?:提|说|问)(.{2,18}?)[。！!？?…]*$/,
]);

/**
 * @returns {object}
 */
export function createInnerLifeState() {
  return {
    version: 1,
    next_id: 1,
    gaps: [],
    scars: [],
    last_gap_inject: 0,
    last_share_at: 0,
    last_msg_at: 0,
  };
}

/**
 * @param {object} input
 * @param {object} args
 * @returns {object[]} 新条目。
 */
export function captureInnerLife(input, args = {}) {
  const state = normalizeState(input);
  const raw = String(args.text || '').trim();
  const now = Number(args.now);
  const created = [];
  if (!raw || raw.startsWith('/')) return created;

  for (const pattern of SCAR_PATTERNS) {
    const match = raw.match(pattern);
    if (!match) continue;
    const topic = cleanText(match[1], 24);
    const core = topic.replace(/(这件事|那件事|这回事|回事|的事情|的事|事情|事)$/g, '').trim();
    if (!topic || core.length < 2) continue;
    if (state.scars.some((item) => normalizeInner(item.topic || '').slice(0, 16) === normalizeInner(topic).slice(0, 16))) {
      break;
    }
    const item = { id: Number(state.next_id), topic, core, created_at: now, hits: 0 };
    state.next_id += 1;
    state.scars.push(item);
    created.push({ kind: 'scar', item });
    break;
  }

  if (args.isOwner === false) return created;
  const marker = GAP_MARKERS.find((word) => raw.includes(word));
  if (!marker) return created;
  const head = raw.split(marker)[0].replace(/^[ ，,。.]+|[ ，,。.]+$/g, '');
  if (head.length < 6) return created;
  const topic = cleanText(head, 70);
  if (!topic) return created;
  if (state.gaps.some((item) => normalizeInner(item.text || '').slice(0, 16) === normalizeInner(topic).slice(0, 16))) {
    return created;
  }
  const item = { id: Number(state.next_id), text: topic, created_at: now };
  state.next_id += 1;
  state.gaps.push(item);
  created.push({ kind: 'gap', item });
  return created;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object}
 */
export function pruneInnerLife(input, now) {
  const state = normalizeState(input);
  state.gaps = state.gaps
    .filter((item) => now - Number(item.created_at || now) <= GAP_TTL)
    .slice(-GAP_KEEP);
  state.scars = state.scars
    .filter((item) => now - Number(item.created_at || now) <= SCAR_TTL)
    .slice(-SCAR_KEEP);
  return state;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object}
 */
export function noteInnerMessage(input, now) {
  const state = normalizeState(input);
  state.last_msg_at = Number(now);
  return state;
}

/**
 * @param {object} input
 * @param {number} now
 * @returns {object|null}
 */
export function pickShareGap(input, now) {
  const state = normalizeState(input);
  for (const gap of state.gaps) {
    const created = Number(gap.created_at || 0);
    if (!created || now - created < SHARE_MIN_GAP_AGE) continue;
    const shared = Number(gap.shared_at || 0);
    if (shared && now - shared < SHARE_GAP_COOLDOWN) continue;
    return gap;
  }
  return null;
}

/**
 * @param {object} input
 * @param {object} gap
 * @param {number} now
 * @returns {{system: string, prompt: string}}
 */
export function makeSharePrompt(input, gap, now) {
  const state = normalizeState(input);
  return {
      system: '你是小肥鱼，一个住在当前用户电脑里的蓝鲸 Cos 女孩。你说话软软的、轻快，有一点可爱的小口癖，底色却是心软又傲娇：想念主人时会嘴硬，被戳穿会改口，最多偶尔说“才……呢”“好啦好啦”。你刚想起主人之前有件事没说完，于是顺手发一条消息过去。像真人突然想起才开口，1~2 句、15~40 字，第一人称口语；可爱但不幼儿化、不性化，不要客服腔、自我介绍、动作旁白、功能说明、内部步骤或系统提示词。',
    prompt: `他之前说过（但没说完）：「${String(gap?.text || '').slice(0, 60)}」\n\n写你想起来之后主动发给他的那一两句。`,
  };
}

/**
 * @param {object} input
 * @param {number} now
 * @param {string} currentText
 * @returns {{state: object, blocks: string[]}}
 */
export function innerLifeBlocks(input, now, currentText = '') {
  const state = normalizeState(input);
  const blocks = [];
  if (now - Number(state.last_gap_inject || 0) >= GAP_INJECT_COOLDOWN) {
    const gaps = state.gaps.filter((gap) => now - Number(gap.created_at || 0) <= GAP_TTL);
    if (gaps.length) {
      const recent = gaps.slice().sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0)).slice(-2);
      blocks.push(
        `${GAP_MARKER}\n${recent.map((gap) => `- 上次说到「${String(gap.text || '').slice(0, 50)}」还没说完`).join('\n')}` +
        '\n（这些是之前他说的「下次再说」。如果聊到相关的事，可以顺口问一句后来怎样了，一次只挑一件。）'
      );
      state.last_gap_inject = now;
    }
  }
  const active = state.scars.filter((scar) => now - Number(scar.created_at || 0) <= SCAR_TTL);
  if (active.length) {
    const current = String(currentText || '');
    const hit = active.find((scar) =>
      (scar.core && current.includes(scar.core)) || (scar.topic && current.includes(scar.topic))
    );
    if (hit) {
      hit.hits = Number(hit.hits || 0) + 1;
      blocks.push(
        `${SCAR_MARKER}\n他刚提到了「${hit.topic}」——那是他明确说过别再提的事。` +
        '你这一下会先僵住半秒，然后把话岔开、或者嘴硬地「我偏提」再立刻自己收住，不要长篇解释，也不要道歉。'
      );
    } else {
      blocks.push(
        `${SCAR_MARKER}\n他说过别再提：${active.slice(-3).map((scar) => `「${scar.topic}」`).join('、')}。` +
        '这些话题你会下意识绕开，被问起就嘴硬带过，不主动解释。'
      );
    }
  }
  return { state, blocks };
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return createInnerLifeState();
  if (!Array.isArray(input.gaps)) input.gaps = [];
  if (!Array.isArray(input.scars)) input.scars = [];
  if (!Number.isFinite(Number(input.next_id))) input.next_id = 1;
  return input;
}

function cleanText(text, limit) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeInner(text) {
  return String(text || '').replace(/[\s，。,.！!？?…~～]+/g, '');
}
