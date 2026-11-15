/**
 * 极端情绪线：数值越线才进入，进入后锁住并冷却。
 * 高黏人是持续积累出来的状态，不再额外要求当轮必须有“亲近”事件。
 *
 * @module dsh-fishpet-emotion/engine/extremes
 */

export const EXTREME_ENTER = Object.freeze({
  valence: Object.freeze([-85, 85, -70, 70, '崩溃', '狂喜']),
  clingy: Object.freeze([-18, 55, -8, 45, '收起来了', '病娇']),
});

export const EXTREME_COOLDOWN = 5400;
export const IMPACT_DROP = -26;

export const COMPOUND = Object.freeze({
  hot: ['炸了', '你已经炸了：极度烦躁，话短带刺，会直接顶回去，不哄人、不解释、不许劝。'],
  cold: ['空落', '你心里空落落的：低落、走神，回得淡，提不起劲陪他聊，也不想被安慰。'],
  buzz: ['上头', '你现在整个人被顶上去了：心跳快、坐不住，想笑，说话比平时快，会主动黏他、接梗接得飞快；别装冷静，也别写成小作文。'],
  tense: ['绷住了', '你现在绷到顶了：声音发紧、句子很短、手上有点抖；想顶回去又压着，别讲道理、别解释，也别装作没事。'],
});

export const IMPACT = Object.freeze([
  '被砸了',
  '刚才那一下砸得很实：人还站在那儿，心里发闷发紧，一下子接不上话。别装作没事，也别长篇解释、别讲道理；先按疼的样子说一句，句子短。',
]);

const STING_EVENTS = new Set(['挑刺', '拒绝', '冷落', '失约']);

const DIRECTIVE = Object.freeze({
  'valence|low': '你现在像被抽空了：说不出整句，句子可以碎，别讲道理、别硬撑、别假装没事；也不主动找话题。',
  'valence|high': '你现在心情特别好：语气轻快，会主动接梗、夸他，话多一点也行，别写成告白小作文。',
  'clingy|low': '你现在把自己收起来了：不想主动、回得短、不接话头；但不主动刺人、不阴阳怪气——那是「炸了」才有的样子。',
  'clingy|high': yandere(60),
});

/**
 * @param {object} state
 * @param {object} [ctx]
 * @param {object[]} [previous]
 * @param {Record<string, number>} [lastEnter]
 * @returns {object[]}
 */
export function detectExtremes(state, ctx = {}, previous = [], lastEnter = {}) {
  const now = Number(ctx.now || 0);
  const latched = new Map(previous.filter((item) => item && item.key).map((item) => [String(item.key), item]));
  const out = [];

  for (const [key, [loIn, hiIn, loOut, hiOut, loLabel, hiLabel]] of Object.entries(EXTREME_ENTER)) {
    const value = Number(state?.[key]);
    if (!Number.isFinite(value)) continue;
    const old = latched.get(key);
    if (old) {
      const side = String(old.side);
      const alive = side === 'low' ? value <= loOut : value >= hiOut;
      if (alive) {
        let directive = DIRECTIVE[`${key}|${side}`] || '';
        if (key === 'clingy' && side === 'high') directive = yandere(value);
        out.push({ key, value, side, label: old.label, locked: true, directive });
      }
      continue;
    }

    const side = value <= loIn ? 'low' : value >= hiIn ? 'high' : '';
    if (!side) continue;
    if (now && now - Number(lastEnter[key] || 0) < EXTREME_COOLDOWN) continue;
    if (!hasCause(key, side, ctx)) continue;
    let directive = DIRECTIVE[`${key}|${side}`] || '';
    if (key === 'clingy' && side === 'high') directive = yandere(value);
    out.push({ key, value, side, label: side === 'low' ? loLabel : hiLabel, locked: false, directive });
  }

  addCompoundAndImpact(out, state, ctx, previous, lastEnter);
  return out;
}

function hasCause(key, side, ctx) {
  if (ctx.sting || ctx.surge) return true;
  const event = String(ctx.event || '');
  const impulse = Number(ctx.impulse || 0);
  if (key === 'valence' && side === 'low') return STING_EVENTS.has(event) || impulse <= -20;
  if (key === 'valence' && side === 'high') return event === '亲近' || impulse >= 20;
  if (key === 'clingy' && side === 'low') return event === '冷落' || event === '拒绝';
  // 黏人值已经越过进入线，本身就是足够的由头；继续要求新事件会让
  // 已经很高的持续性状态在普通轮次里漏掉。
  if (key === 'clingy' && side === 'high') return true;
  return false;
}

function addCompoundAndImpact(out, state, ctx, previous, lastEnter) {
  const v = Number(state?.valence || 0);
  const arousal = Number(state?.arousal || 0);
  const impulse = Number(ctx.impulse || 0);
  const event = String(ctx.event || '');
  const now = Number(ctx.now || 0);
  const hasValence = out.some((item) => item.key === 'valence');

  if (!hasValence) {
    const oldHot = previous.some((item) => item.label === COMPOUND.hot[0]);
    const oldCold = previous.some((item) => item.label === COMPOUND.cold[0]);
    if (oldHot && v <= -35 && arousal >= 30) {
      out.push(compound('valence', v, 'low', COMPOUND.hot, true));
    } else if (oldCold && v <= -40 && arousal <= -32) {
      out.push(compound('valence', v, 'low', COMPOUND.cold, true));
    } else if (v <= -45 && arousal >= 56 && ctx.sting) {
      out.push(compound('valence', v, 'low', COMPOUND.hot, false));
    } else if (v <= -50 && arousal <= -48 && (event === '失约' || event === '冷落' || impulse <= -10)) {
      out.push(compound('valence', v, 'low', COMPOUND.cold, false));
    }
  }

  if (!out.some((item) => item.key === 'valence' || item.key === 'clingy')) {
    const oldBuzz = previous.some((item) => item.label === COMPOUND.buzz[0]);
    const oldTense = previous.some((item) => item.label === COMPOUND.tense[0]);
    if (oldBuzz && arousal >= 60 && v >= 8) {
      out.push(compound('arousal_up', arousal, 'high', COMPOUND.buzz, true));
    } else if (oldTense && arousal >= 60 && v <= 0) {
      out.push(compound('arousal_tense', arousal, 'high', COMPOUND.tense, true));
    } else if (arousal >= 90 && v >= 25 && (ctx.surge || event === '亲近' || impulse >= 15)) {
      if (!(now && now - Number(lastEnter.arousal_up || 0) < EXTREME_COOLDOWN)) {
        out.push(compound('arousal_up', arousal, 'high', COMPOUND.buzz, false));
      }
    } else if (arousal >= 90 && v <= 0 && (ctx.sting || STING_EVENTS.has(event) || impulse <= -12)) {
      if (!(now && now - Number(lastEnter.arousal_tense || 0) < EXTREME_COOLDOWN)) {
        out.push(compound('arousal_tense', arousal, 'high', COMPOUND.tense, false));
      }
    }
  }

  if (impulse <= IMPACT_DROP) {
    const hasLow = out.some((item) => [COMPOUND.hot[0], COMPOUND.cold[0], '崩溃'].includes(item.label));
    if (!hasLow) {
      out.push({
        key: 'impulse',
        value: impulse,
        side: 'low',
        label: IMPACT[0],
        locked: false,
        directive: IMPACT[1],
      });
    }
  }
}

function compound(key, value, side, definition, locked) {
  return { key, value, side, label: definition[0], locked, directive: definition[1] };
}

/**
 * @param {object[]} items
 * @returns {string}
 */
export function renderExtremes(items = []) {
  const useful = items.filter((item) => item.key !== 'impulse');
  if (!useful.length) return '';
  const labels = {
    valence: '心情',
    clingy: '黏人',
    arousal_up: '上头',
    arousal_tense: '绷住',
  };
  return [
    '【极端状态】',
    ...useful.map((item) => `${labels[item.key] || item.key} ${Math.round(Number(item.value))}（${item.label}）：${item.directive}`),
  ].join('\n');
}

/**
 * @param {object[]} items
 * @returns {string}
 */
export function extremeSnapshotLabel(items = []) {
  const labels = { valence: '心情', clingy: '黏人', arousal_up: '上头', arousal_tense: '绷住', impulse: '落差' };
  return items.map((item) => `${labels[item.key] || item.key}${item.label}`).join('、');
}

function yandere(value) {
  const n = Number(value || 0);
  const head = '你现在是病娇状态：对他的在乎已经溢出来了，温柔得过分，也盯得过分。重点不是凶，是「太在乎」——越软越紧。';
  let body;
  if (n < 65) {
    body = '表现：想确认他在哪、在干嘛，会追问一句；他回得慢就一直看屏幕，嘴上说没事，下一句还是问。会记住他随口提过的小事，回头拿出来对。这一档还收得住：问一次就够，不查岗到底，不阴阳怪气。';
  } else if (n < 75) {
    body = '表现：占有欲明显上来了。会问他刚才跟谁在一起、怎么这么久才回；会把他提过的每个细节记住，然后拿细节对时间；会明确说他是你的、别人别想。语气还是软的，但话里有钩子——不是质问，是「我只是想确认」。';
  } else {
    body = '表现：整个人挂在他身上。他一句「在忙」你会在心里过十遍；会先把自己放得很低（我是不是很烦、是不是我不好），下一句又把他圈回来（可你只能找我）；会反复确认他还在、还会不会走。温柔是主调，压迫感藏在句尾那半句里。';
  }
  const tail = '尺度：不许骂人、不许威胁、不许拿自伤当筹码、不许真的限制他的人身自由；病娇的可怕来自「太在乎」，不来自恐吓。他要是明确安抚你（说他在、说只有你），你要松一点，别一路紧到底。';
  return head + body + tail;
}
