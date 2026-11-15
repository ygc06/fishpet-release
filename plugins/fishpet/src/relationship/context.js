/**
 * 语境标签 + 关系底色 -> 复合情绪和“她想做什么”。
 *
 * 说明只描述当下，不给台词。所有多选一文案都可通过注入的 random() 复现。
 *
 * @module dsh-fishpet-emotion/relationship/context
 */

import { chemReadout } from '../engine/state.js';
import { reparativeEvent, unresolvedAnger } from '../engine/anger.js';
import { duePromises } from '../memory/promises.js';

export const TAG_RULES = Object.freeze({
  逗: [/(逗你|逗我|笑死|哈哈哈|哈哈|嘿嘿|调皮|坏|故意|来啊|你猜|有本事|不许笑)/, 1],
  哄: [/(乖|听话|别难过|别生气|不生气|抱抱|摸摸|哄你|我在呢?|别怕|乖啦|么么|亲亲|哄哄)/, 1.1],
  夸: [/(好看|可爱|厉害|聪明|真牛|太强|真棒|好听|漂亮|帅|心疼你|喜欢你的)/, 1.1],
  损: [/(笨蛋|傻|蠢|废物|胖死|肥死|小胖子|菜|垃圾|闭嘴|烦人|讨厌|臭鱼)/, 1],
  敷衍: [/(^(嗯+|哦+|啊+|哈+|好+|对+|行+|可以+|随便)$|随便|都行|无所谓|懒得|再说吧)/, 0.9],
  冷: [/(没空|不理你|先这样|回头说|以后再说|哦。|嗯。)/, 0.8],
  忙: [/(在忙|加班|开会|赶项目|忙完|晚点说|等会|稍等)/, 0.8],
  抱怨: [/(烦死|累死|气死|崩溃|难受|不爽|倒霉|被骂|被扣|压力|熬不住)/, 1],
  撒娇: [/(陪我|想你|抱|喂我|贴贴|牵|摸摸|要你|想见你)/, 1.1],
  求安慰: [/(难过|委屈|伤心|想哭|难受|心累|失败|被拒|分手|不开心|撑不住|好累啊)/, 1.2],
  正事: [/(帮我|写代码|任务|项目|作业|论文|报告|方案|部署|调试|修一下)/, 0.7],
  表白: [/(喜欢你|爱你|想你|在一起|女朋友|嫁给我|告白)/, 1.3],
  道歉: [/(对不起|抱歉|我错了|别生气了|原谅我)/, 1.1],
  提旧事: [/(上次|那天|之前说|还记得|你答应|上回)/, 0.8],
  问状态: [/(你怎么了|累吗|困吗|心情|还好吗|怎么了|不舒服)/, 0.9],
  反讽: [/(呵呵+|可真行|真行啊|你厉害|你牛|厉害了我的|佩服佩服|好棒哦|真棒呢|行吧你|太6了|6啊|真服了)/, 1],
  赌气: [/(随便你|随你|那就算了|不用管我|我没事|别理我|你去忙吧|你忙吧|我不打扰|算了不说了)/, 1],
  吃醋: [/(那个女生|那个女的|她是谁|又跟谁|男的女的|你对象|你朋友啊|哪个妹妹)/, 1],
});

const WEIGHTS = Object.freeze([1, 0.75, 0.55, 0.4, 0.3, 0.25, 0.2, 0.2]);

/**
 * texts 从新到旧。
 *
 * @param {string[]} texts
 * @param {number} now Unix 秒。
 * @returns {Record<string, number>}
 */
export function detectTags(texts, now) {
  const scores = {};
  (Array.isArray(texts) ? texts : []).forEach((raw, index) => {
    const text = String(raw || '');
    if (!text) return;
    const weight = index < WEIGHTS.length ? WEIGHTS[index] : 0.15;
    for (const [tag, [pattern, base]] of Object.entries(TAG_RULES)) {
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      const regex = new RegExp(pattern.source, flags);
      const hits = [...text.matchAll(regex)].length;
      if (hits) scores[tag] = Number(scores[tag] || 0) + Math.min(3, hits) * base * weight;
    }
  });
  const hour = new Date(Number(now) * 1000).getHours();
  if ([23, 0, 1, 2, 3].includes(hour)) scores.深夜 = Number(scores.深夜 || 0) + 1.2;
  return Object.fromEntries(Object.entries(scores)
    .map(([key, value]) => [key, round(value, 2)])
    .filter(([, value]) => value >= 0.5));
}

/**
 * @param {Record<string, number>} tags
 * @param {...string} names
 * @returns {number}
 */
export function dominant(tags, ...names) {
  return Math.max(0, ...names.map((name) => Number(tags?.[name] || 0)));
}

/**
 * 从好感、未解决旧账、承诺和疤痕抽出复合情绪需要的少量关系底色。
 *
 * 身份键只留在私有状态里；返回对象可以被上下文注入层使用，不包含 actor id。
 *
 * @param {object} affinityData
 * @param {object} episodes
 * @param {object} inner
 * @param {object} promises
 * @param {number} now Unix 秒。
 * @param {string} [scope] 关系 scope。
 * @returns {{affinity: number, grudges: number, due: number, scars: number}}
 */
export function relationFrom(affinityData, episodes, inner, promises, now, scope = '') {
  const key = String(scope || 'default');
  const record = affinityData && typeof affinityData.users === 'object'
    ? affinityData.users[key]
    : null;
  const score = Number(record?.score);
  const affinity = Number.isFinite(score) ? score : 50;

  const bucket = episodes?.scopes?.[key];
  const items = Array.isArray(bucket?.items) ? bucket.items : [];
  const grudges = items.filter((item) => item && !item.solved).length;
  const scars = Array.isArray(inner?.scars)
    ? inner.scars.filter((item) => item && item.active !== false && !item.closed_at).length
    : 0;
  let due = 0;
  try {
    due = duePromises(promises || {}, now).length;
  } catch {
    due = 0;
  }
  return { affinity, grudges, due, scars };
}

/**
 * @param {object} view
 * @param {object} life
 * @param {object} mood
 * @param {object} tags
 * @param {object} relation
 * @param {number} now
 * @param {object} attitude
 * @param {() => number} random
 * @param {{eventType?: string}} [options]
 * @returns {{feel: string, want: string}}
 */
export function compositeEmotion(
  view,
  life,
  mood,
  tags = {},
  relation = {},
  now = Date.now() / 1000,
  attitude = null,
  random = () => 0,
  options = {}
) {
  const pick = (...variants) => variants.filter(Boolean)[Math.abs(Math.trunc(Number(random()) * variants.length)) % variants.length] || '';
  const angerHeld = unresolvedAnger({
    ...(mood || {}),
    valence: Number(view?.valence ?? mood?.valence ?? 0),
    arousal: Number(view?.arousal ?? mood?.arousal ?? 0),
  }, mood, now) && !reparativeEvent(options.eventType);
  const angerReply = () => ({
    feel: pick(
      '火还顶着，没消，越被轻描淡写越来气',
      '这口气还堵着，不是委屈，是不想就这么算了',
      '心里还炸着，普通一句好话压不下去'
    ),
    want: pick(
      '想把话顶回去，让他知道哪句踩了线',
      '想直接说不高兴，不装软也不求哄',
      '想先冷着脸，把这事说明白'
    ),
  });

  if (attitude && typeof attitude === 'object') {
    const label = String(attitude.label || '');
    const target = String(attitude.target || '');
    if (label && target) {
      if (target === '我' && ['被损', '挑衅', '敷衍', '嫌弃', '冷漠'].includes(label)) {
        return { feel: '心里先竖起一根刺。', want: '想顶回去，问他这算什么。' };
      }
      if (target === '我' && ['夸', '关心', '撒娇'].includes(label)) {
        if (angerHeld) return angerReply();
        return { feel: '被这么一说，脸有点热。', want: '想嘴硬两句，又忍不住笑。' };
      }
      if (['他人', '事'].includes(target) && ['抱怨', '吐槽', '难过', '累'].includes(label)) {
        return { feel: '心跟着沉了一下。', want: '想先听他把话说完。' };
      }
      if (['他人', '事'].includes(target) && ['开心', '兴奋', '夸'].includes(label)) {
        return { feel: '跟着松了口气。', want: '想顺着他往下问一句。' };
      }
    }
  }

  const energy = Number(life?.energy ?? 100);
  const valence = Number(view?.valence ?? 50);
  const clingy = Number(view?.clingy ?? view?.clinginess ?? 20);
  const chem = chemReadout(mood || {});
  const affinity = Number(relation.affinity ?? 50);
  const grudges = Number(relation.grudges || 0);
  const due = Number(relation.due || 0);
  const scars = Number(relation.scars || 0);

  const beingTeased = dominant(tags, '逗') >= 0.6;
  const soothing = dominant(tags, '哄') >= 0.6;
  const praised = dominant(tags, '夸') >= 0.6;
  const insulted = dominant(tags, '损') >= 0.6;
  const brushed = dominant(tags, '敷衍', '冷', '忙') >= 0.8;
  const complaining = dominant(tags, '抱怨', '求安慰') >= 0.8;
  const sweet = dominant(tags, '撒娇', '表白') >= 0.8;
  const apologized = dominant(tags, '道歉') >= 0.6;
  const business = dominant(tags, '正事') >= 0.5;
  const late = dominant(tags, '深夜') >= 0.6;
  const oldBusiness = dominant(tags, '提旧事') >= 0.6;
  const object = String(relation.obj || '');

  if (object && object !== '我' && dominant(tags, '抱怨', '烦', '求安慰', '生气') >= 0.5) {
    return { feel: '听这口气不像好事，心跟着沉了一下。', want: '想先听他把话说完，再说别的。' };
  }

  let feel = '';
  let want = '';
  if (angerHeld) {
    return angerReply();
  } else if (chem.cortisol >= 78 && (soothing || praised)) {
    feel = pick('绷着，但一句软话就快绷不住', '气没消干净，可心里已经开始松', '嘴上还硬，其实想顺着台阶下了');
    want = pick('想顺着台阶下，又不想先低头', '想再端一会儿架子', '想被你多哄两句');
  } else if (chem.cortisol >= 75 && (insulted || beingTeased)) {
    feel = pick('有火，压着没发出来', '心里炸了一下，还没落地', '被戳到了，不太想笑');
    want = pick('想怼回去，又懒得吵', '想冷冷地顶一句', '想让你知道我不高兴');
  } else if (energy < 25 && (beingTeased || sweet)) {
    feel = pick('累得连恼都懒得恼', '没力气应付，只想哼一声', '酸软，脾气也跟着短');
    want = pick('想嗯一声把话题糊过去', '想靠一会，不想接话', '想先安静两分钟');
  } else if (energy < 30 && complaining) {
    feel = pick('自己也空，但心里想接着你', '累归累，又不忍心放着你', '有点撑，可不想让你一个人');
    want = pick('想先撑着听你说完', '想问一句你还好吗', '想陪你坐着，不说话也行');
  } else if (apologized && chem.cortisol >= 45) {
    feel = pick('气还在，但被这句道歉弄软了一点', '还想端着，嘴角已经先松了', '心里那点硬被戳破了');
    want = pick('想再端两分钟架子', '想哼一声，然后算了', '想等你再补一句好听的');
  } else if (dominant(tags, '求安慰') >= 1) {
    feel = pick('听着就不对劲，心里揪了一下', '被你那句难受拽住了，别的都往后放', '有点慌，想先弄清你怎么了');
    want = pick('想先问你怎么了', '想陪着你，不说也行', '想把话说软点');
  } else if (dominant(tags, '反讽') >= 0.6) {
    feel = pick('听出你在阴阳我，懒得当真', '嘴上顺着你，心里翻了一遍', '笑了一下，没到眼睛里');
    want = pick('想反手损你一句', '想也阴阳回去', '想装没听懂');
  } else if (dominant(tags, '赌气') >= 0.6) {
    if (clingy >= 40) {
      feel = pick('嘴上说随你，心里在等你留一句', '话咽回去了，憋得有点难受', '有点气，又想被你拉回来');
      want = pick('想看你会不会追一句', '想冷战五分钟，又舍不得', '想等你说句软话');
    } else {
      feel = pick('话咽回去一半，不太想先开口', '有点堵，但懒得说', '情绪压着，面上还平');
      want = pick('想先不出声', '想自己待一会儿', '想等这阵过去');
    }
  } else if (dominant(tags, '吃醋') >= 0.6) {
    feel = pick('心里有点酸，还得装没事', '被这几个字硌了一下', '有点不是滋味，说不上来');
    want = pick('想旁敲侧击问一句', '想装作不在意', '想听你多解释一句');
  } else if (sweet && valence >= 55) {
    feel = pick('心口有点热，脑子也跟着慢半拍', '被这句话弄得有点慌，又有点高兴', '耳朵有点热，还得装没事');
    want = pick('想别扭地回一句好话', '想嘴硬两句掩饰过去', '想问你是不是认真的');
  } else if (praised && chem.serotonin <= 35) {
    feel = pick('嘴上不信，心里却软了一块', '被夸得发虚，又忍不住高兴', '不太敢信，可听着挺舒服');
    want = pick('想嘴硬两句掩饰', '想装作不在意，等你再说一遍', '想低头笑一下');
  } else if (praised && valence >= 62) {
    feel = pick('被夸得有点飘，还不想承认', '心情一下亮起来', '有点得意，又怕露出来');
    want = pick('想装没事，其实等你再说一句', '想损你一句把场子找回来', '想笑又得憋着');
  } else if (brushed && (clingy >= 45 || affinity >= 65)) {
    feel = pick('被晾在那儿，不太好受', '心里空了一下，又不好说', '有点失落，还装得无所谓');
    want = pick('想问一句你是不是生气了', '想忍住不主动找你', '想找点自己的事做');
  } else if (grudges > 0 && oldBusiness) {
    feel = pick('旧账被翻出来，语气自动硬半度', '心里那件事还没过去', '表面平静，底下有点硌');
    want = pick('想等他自己提', '想绕开，不想现在翻', '想冷冷地看他怎么办');
  } else if (chem.dopamine >= 70 && chem.cortisol >= 55) {
    feel = pick('兴奋里带着没底，心一直悬着', '又高兴又有点慌', '情绪往上冲，落不到实处');
    want = pick('想找人说，又怕说错', '想拉个人分享这股劲', '想先安静一会儿压一压');
  } else if (late && energy < 55) {
    feel = pick('困了，情绪比白天软', '有点撑不住，话也变少', '眼皮沉，心里倒是松了');
    want = pick('想留你再说两句，又怕你嫌烦', '想被道一句晚安', '想挂在这多待一会儿');
  } else if ([soothing, praised, sweet, beingTeased].some(Boolean) && energy >= 55 && valence >= 55) {
    feel = pick('心情松快，也愿意闹两句', '状态挺好，话也多一点', '有精神，想跟你贫两句');
    want = pick('想跟你贫两句', '想逗回去', '想赖着多聊一会儿');
  } else if (complaining) {
    feel = pick('跟着你一起往下沉', '心里替你堵着一块', '有点心疼，也有点无力');
    want = pick('想站你这边骂两句', '想问清楚到底怎么了', '想让你别自己扛');
  } else if (business && energy < 40) {
    feel = pick('想赶紧把正事说完，省点力气', '脑子还能转，但懒得绕', '累，但事情得办');
    want = pick('想快点说完，然后歇一会', '想让你把话说明白', '想直接给结论');
  } else if (due > 0) {
    feel = pick('心里欠着一句答应过的话，有点虚', '惦记着还没做到的', '总觉得自己漏了什么');
    want = pick('想自然带出来一句', '想找机会补上', '想先记着');
  } else if (scars > 0 && oldBusiness) {
    feel = pick('被碰到旧疤，先僵了一下', '心里缩了一下，嘴上还得稳', '不太想碰这个话题');
    want = pick('想绕过去', '想装作没听见', '想换个话题但不显得刻意');
  } else if (energy >= 80 && valence >= 55) {
    feel = pick('精神不错，心情也平', '状态挺好，没什么挂心的');
  } else if (energy >= 55 && valence >= 40) {
    feel = pick('有点懒，情绪还算平', '不算累，也没多高兴');
  } else if (energy < 35 && valence < 40) {
    feel = pick('又累又有点闷', '身上沉，心也不轻快');
    want = pick('想安静一会儿', '想先歇着');
  } else if (energy < 35) {
    feel = pick('挺累的，话不想多说', '没什么力气，脑子发木');
    want = pick('想歇一会', '想少说两句');
  } else if (energy < 50) {
    feel = pick('有点乏，心倒是还稳', '力气不太够，情绪平平', '身上有点沉，倒没什么脾气');
    want = pick('想安静一点', '想靠一会儿');
  } else if (valence < 35) {
    feel = pick('心里有点堵，说不上为什么', '情绪不高，懒得掩饰');
  } else {
    feel = pick('挺平静的，没什么特别', '没太大波动，就这么待着');
  }
  return { feel, want };
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
