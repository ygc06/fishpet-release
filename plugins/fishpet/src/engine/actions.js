/**
 * 第 2 层动作规则：四项动作与证据门槛。
 *
 * 常量直接复用第 1 层契约，避免再出现一处只认前三项、另一处认四项的漂移。
 * 本模块不读写状态、不调用模型，输入相同则输出相同。
 *
 * @module dsh-fishpet-emotion/engine/actions
 */

import { ACTIONS, ACT_FALLBACK, EVENT_FALLBACK } from '../domain/enums.js';

/**
 * 「限制人身」的唯一字面清单，逐字对齐旧 `acts.py` 的 `_LIMIT`。
 *
 * 第 1 层判读契约与第 2 层状态应用都从这里取，禁止再各存一份。
 */
export const BOUNDARY_SIGNALS = Object.freeze([
  '别跟别人',
  '不许跟',
  '不准跟',
  '不许和',
  '不准和',
  '只能跟我',
  '别联系',
  '别理他',
  '别理她',
  '删了他',
  '拉黑',
  '不许去',
  '不准去',
  '不许走',
  '不准走',
]);

/** 只有这四类事件能撑起「划界退开」，与旧 `acts.py` 的 `_STRONG` 一致。 */
export const STRONG_EVENTS = Object.freeze(['挑刺', '失约', '拒绝', '冷落']);

/** 每条动作交给下游生成回复的“只写做法，不写台词”提示。 */
export const ACTION_HOW = Object.freeze({
  靠近: '往他那边靠一点：接住他的话，可以主动一点，别端着',
  说难受: '把难受说出来就够：说你自己怎么了，不追问他为什么，也不翻旧账',
  划界退开: '把线摆出来：说清哪件事不行，然后停下——不解释，也不追着他要回应',
  认一句: '认清楚是哪一件：说自己哪句话、哪件事做得不对，不解释、不找补、也别演得可怜；认完就停，账照样可以算',
});

/**
 * 返回原话命中的限制人身信号；没命中返回空串。
 *
 * @param {unknown} text 当前原话。
 * @returns {string}
 */
export function findBoundarySignal(text) {
  const said = String(text ?? '');
  return BOUNDARY_SIGNALS.find((word) => said.includes(word)) || '';
}

/**
 * 兼容旧 `acts.resolve()` 的二维返回值，同时保持四项动作。
 *
 * @param {unknown} modelAct 模型给出的动作。
 * @param {unknown} [etype] 事件类型。
 * @param {boolean} [quoteOk] 摘句是否已逐字核对。
 * @param {unknown} [text] 当前原话。
 * @returns {{act: string, reason: string}}
 */
export function resolveAction(modelAct, etype = '', quoteOk = true, text = '') {
  const hit = findBoundarySignal(text);
  const wanted = String(modelAct ?? '').trim();
  const degraded = [];

  // 白名单是动作证据的第一道门。模型给了非法动作时，不能因为原话里刚好有
  // 「不许走」之类词，就把它抬成一个合法动作；那等于绕过模型输出校验。
  if (wanted && !ACTIONS.includes(wanted)) {
    return {
      act: ACT_FALLBACK,
      reason: '模型给的动作不在白名单——按最轻的一种：只说自己的感受',
      degraded: ['act.illegal', 'act.fallback'],
    };
  }

  if (hit && (wanted === '靠近' || wanted === '说难受' || wanted === '')) {
    return {
      act: '划界退开',
      reason: `他说了「${hit}」——这是管她，字面就够硬`,
      degraded: wanted === '划界退开' ? degraded : [...degraded, 'act.boundary-upgrade'],
    };
  }

  if (!ACTIONS.includes(wanted)) {
    return {
      act: ACT_FALLBACK,
      reason: '模型没给动作——按最轻的一种：只说自己的感受',
      degraded: ['act.fallback'],
    };
  }

  if (wanted === '认一句') {
    if (!quoteOk) {
      return {
        act: ACT_FALLBACK,
        reason: '想认，但这一轮摘不出他原话——先只说自己的感受',
        degraded: [...degraded, 'act.needs-quote'],
      };
    }
    if (String(etype || '') === '亲近') {
      return {
        act: ACT_FALLBACK,
        reason: '这一轮没有她做得不对的事——认什么',
        degraded: [...degraded, 'act.needs-evidence'],
      };
    }
    return {
      act: '认一句',
      reason: '他自己把事摆出来了，这一轮认得出是哪一件',
      degraded,
    };
  }

  if (wanted === '划界退开') {
    if (hit) {
      return {
        act: '划界退开',
        reason: `他说了「${hit}」，这一轮该划线`,
        degraded: [...degraded, 'act.boundary-upgrade'],
      };
    }
    const type = String(etype || '');
    if (!STRONG_EVENTS.includes(type)) {
      return {
        act: ACT_FALLBACK,
        reason: `想划线，但这一轮的事撑不住（${type || EVENT_FALLBACK}）——只说自己的感受`,
        degraded: [...degraded, 'act.needs-strong-event'],
      };
    }
    if (!quoteOk) {
      return {
        act: ACT_FALLBACK,
        reason: '想划线，但摘不出他原话——只说自己的感受',
        degraded: [...degraded, 'act.needs-quote'],
      };
    }
  }

  return { act: wanted, reason: '模型给的动作站得住', degraded };
}

/**
 * 转成注入给回复模型的一行。
 *
 * @param {unknown} act 动作。
 * @returns {string}
 */
export function actionLine(act) {
  const how = ACTION_HOW[String(act ?? '')] || '';
  return how ? '【这一轮我要做的】' + how : '';
}
