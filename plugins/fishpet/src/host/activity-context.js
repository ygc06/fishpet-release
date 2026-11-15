/**
 * 主人前台软件活动的短上下文。
 *
 * FishPet Electron 只发送规范化的软件 id、类别和停留时长；这里再次收窄并
 * 丢弃过期/不完整数据。窗口标题、网址、文件名、路径、进程 PID、聊天和
 * 键鼠内容都不进入协议，也不会出现在提示词里。
 *
 * @module dsh-fishpet-emotion/host/activity-context
 */

export const ACTIVITY_CONTEXT_SCHEMA_VERSION = 1;
export const ACTIVITY_CONTEXT_MAX_AGE_MS = 90_000;
export const ACTIVITY_CONTEXT_MAX_FUTURE_MS = 5_000;

const ACTIVITY_STATES = new Set(['active', 'idle', 'locked']);

const APP_CATALOG = Object.freeze({
  dsh: { label: 'DeepSeek Harness', category: 'development' },
  chatgpt: { label: 'ChatGPT', category: 'chat' },
  vscode: { label: 'VS Code', category: 'development' },
  cursor: { label: 'Cursor', category: 'development' },
  terminal: { label: '终端', category: 'development' },
  browser: { label: '浏览器', category: 'browser' },
  wechat: { label: '微信', category: 'chat' },
  qq: { label: 'QQ', category: 'chat' },
  discord: { label: 'Discord', category: 'chat' },
  telegram: { label: 'Telegram', category: 'chat' },
  slack: { label: 'Slack', category: 'chat' },
  teams: { label: 'Microsoft Teams', category: 'chat' },
  feishu: { label: '飞书', category: 'chat' },
  office: { label: '办公软件', category: 'work' },
  files: { label: '文件管理器', category: 'work' },
  steam: { label: 'Steam', category: 'game' },
  game: { label: '游戏', category: 'game' },
  media: { label: '影音播放器', category: 'media' },
  immersive: { label: '全屏软件', category: 'immersive' },
  fishpet: { label: '大肥鱼', category: 'companion' },
  private: { label: '一个私密软件', category: 'private' },
  unknown: { label: '一个未识别软件', category: 'other' },
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampSeconds(value, max) {
  const number = finiteNumber(value);
  if (number == null || number < 0) return 0;
  return Math.min(max, Math.floor(number));
}

function durationText(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return '不到一分钟';
  if (total < 3600) return `约${Math.max(1, Math.round(total / 60))}分钟`;
  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    return minutes >= 10 ? `约${hours}小时${minutes}分钟` : `约${hours}小时`;
  }
  const days = Math.floor(total / 86400);
  return `约${days}天`;
}

/**
 * 把桌面端快照收敛成提示词可用的最小事实。
 *
 * @param {unknown} input
 * @param {{now?: number, maxAgeMs?: number, maxFutureMs?: number}} [options]
 * @returns {null|{schemaVersion:number,sampledAt:number,state:string,app:null|{id:string,label:string,category:string},durationSec:number,idleSec:number}}
 */
export function normalizeActivityContext(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Number(input.schemaVersion) !== ACTIVITY_CONTEXT_SCHEMA_VERSION) return null;
  if (input.enabled === false || input.available === false || input.stale === true) return null;

  const now = finiteNumber(options.now) ?? Date.now();
  const sampledAt = finiteNumber(input.sampledAt);
  if (sampledAt == null || sampledAt <= 0) return null;
  const maxAgeMs = Math.max(1_000, finiteNumber(options.maxAgeMs)
    ?? ACTIVITY_CONTEXT_MAX_AGE_MS);
  const maxFutureMs = Math.max(0, finiteNumber(options.maxFutureMs)
    ?? ACTIVITY_CONTEXT_MAX_FUTURE_MS);
  if (sampledAt > now + maxFutureMs || now - sampledAt > maxAgeMs) return null;

  const state = String(input.state || '').trim().toLowerCase();
  if (!ACTIVITY_STATES.has(state)) return null;

  let app = null;
  if (state !== 'locked' && input.app && typeof input.app === 'object') {
    const id = String(input.app.id || '').trim().toLowerCase();
    const info = APP_CATALOG[id];
    if (info && Object.hasOwn(APP_CATALOG, id)) {
      app = { id, label: info.label, category: info.category };
    } else {
      app = {
        id: 'unknown',
        label: APP_CATALOG.unknown.label,
        category: APP_CATALOG.unknown.category,
      };
    }
  }
  if (state === 'active' && !app) return null;

  return {
    schemaVersion: ACTIVITY_CONTEXT_SCHEMA_VERSION,
    sampledAt: Math.floor(sampledAt),
    state,
    app,
    durationSec: clampSeconds(input.durationSec, 7 * 86400),
    idleSec: clampSeconds(input.idleSec, 365 * 86400),
  };
}

/**
 * 生成一条自然使用、但明确限制认知边界的陪伴上下文。
 *
 * @param {unknown} input
 * @param {{now?: number, maxAgeMs?: number}} [options]
 * @returns {string}
 */
export function activityContextText(input, options = {}) {
  const value = normalizeActivityContext(input, options);
  if (!value) return '';
  const lines = ['【主人现在在做什么 · 本机软件感知】'];

  if (value.state === 'locked') {
    lines.push('电脑当前处于锁屏状态，主人可能暂时离开了。');
  } else if (value.state === 'idle') {
    const app = value.app ? `最后看到的是“${value.app.label}”` : '没有拿到当前软件';
    lines.push(
      `主人已经${durationText(value.idleSec)}没有键鼠操作，${app}。` +
      '她可以理解主人可能暂时离开了，不要催问。',
    );
  } else {
    lines.push(
      `主人现在在前台使用“${value.app.label}”，已经${durationText(value.durationSec)}。` +
      `这个软件大致属于“${value.app.category}”类。`,
    );
  }

  lines.push(
    '她只知道软件身份、大致类别和停留时长；不知道窗口标题、网址、文件、聊天或按键内容。' +
    '不要把短暂停留当成完整任务，也不要编造更具体的内容或反复播报监控数字。' +
    '只有在语境自然或主人问起时，才轻轻带一句。',
  );
  return lines.join('\n');
}

export function activityCatalogEntry(id) {
  const key = String(id || '').trim().toLowerCase();
  return Object.hasOwn(APP_CATALOG, key) ? { id: key, ...APP_CATALOG[key] } : null;
}
