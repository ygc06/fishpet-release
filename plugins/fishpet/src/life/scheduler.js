/**
 * 后台生活的 Host 调度器。
 *
 * 这里只管“什么时候推进一次”，不生成任何剧情。时钟和定时器都可注入；
 * 同一时刻最多一个 tick；停止后不再启动新 tick。DSH 关闭期间定时器不会运行，
 * 重启后也只按当时的时间判断，不补造离线期间的模型内容。
 *
 * @module dsh-fishpet-emotion/life/scheduler
 */

export const DEFAULT_BACKGROUND_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_BACKGROUND_INTERVAL_MS = 60 * 1000;
export const MAX_BACKGROUND_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 把一个时间戳变成稳定、可跨重启去重的 passId。
 *
 * @param {number} nowMs Unix 毫秒。
 * @returns {string}
 */
export function backgroundPassId(nowMs) {
  const value = Number(nowMs);
  const seconds = Number.isFinite(value) && value >= 0 ? Math.trunc(value / 1000) : 0;
  return 'background-' + seconds;
}

/**
 * 创建可清理的后台调度器。
 *
 * @param {object} options
 * @param {{background: Function}} options.service 情绪 Host 服务。
 * @param {() => number} [options.clock] 返回 Unix 毫秒。
 * @param {Function} [options.setInterval] 定时器注册函数。
 * @param {Function} [options.clearInterval] 定时器清理函数。
 * @param {number} [options.intervalMs] 间隔毫秒。
 * @param {boolean} [options.runOnStart] 是否在启动后立即 tick。
 * @param {boolean} [options.allowModel] 是否允许后台 tick 调模型；默认 false。
 * @param {(line: string) => void} [options.log] 脱敏日志。
 * @returns {object}
 */
export function createBackgroundScheduler({
  service,
  clock = () => Date.now(),
  setInterval: registerInterval = setInterval,
  clearInterval: unregisterInterval = clearInterval,
  intervalMs = DEFAULT_BACKGROUND_INTERVAL_MS,
  runOnStart = false,
  allowModel = false,
  log = () => {},
}) {
  if (!service || typeof service.background !== 'function') {
    throw new TypeError('background service required');
  }
  if (typeof registerInterval !== 'function' || typeof unregisterInterval !== 'function') {
    throw new TypeError('timer functions required');
  }

  const delay = Number(intervalMs);
  if (!Number.isFinite(delay) || delay < 1) {
    throw new RangeError('intervalMs must be positive');
  }

  let timer = null;
  let running = null;
  let stopped = false;
  let started = false;
  let ticks = 0;
  let lastResult = null;
  let lastCode = '';

  const safeLog = (line) => {
    try {
      log(line);
    } catch {
      /* 日志失败不影响调度 */
    }
  };

  /**
   * 推进一次。调用方可直接 await，测试无需真的等定时器。
   *
   * @returns {Promise<object>}
   */
  function tick() {
    if (stopped) return Promise.resolve({ ok: false, code: 'scheduler_stopped' });
    if (running) return Promise.resolve({ ok: false, code: 'scheduler_busy', busy: true });

    const now = Number(clock());
    const stamp = Number.isFinite(now) ? now : 0;
    const passId = backgroundPassId(stamp);
    running = Promise.resolve()
      .then(() => service.background({
        passId,
        now: stamp,
        dryRun: !allowModel,
        allowModel,
      }))
      .catch((error) => {
        lastCode = (error && error.code) || 'background_tick_failed';
        safeLog('[emotion] background tick failed code=' + lastCode);
        return { ok: false, code: lastCode, passId };
      })
      .then((result) => {
        ticks += 1;
        lastResult = result && typeof result === 'object' ? result : { ok: false };
        lastCode = result && result.ok === false
          ? String(result.code || 'background_tick_failed')
          : '';
        return lastResult;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  /**
   * 注册一条 interval；重复调用是幂等的。
   *
   * @returns {boolean} 本次是否新注册了定时器。
   */
  function start() {
    if (stopped || timer !== null) return false;
    started = true;
    timer = registerInterval(() => {
      if (!stopped) void tick();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    safeLog('[emotion] background scheduler intervalMs=' + delay);
    if (runOnStart) void tick();
    return true;
  }

  /**
   * 清掉定时器，不等待可能忽略 abort 的模型调用。Host 会随后关闭 service，
   * 正在跑的 tick 即使迟到也会在提交前看到 closed=true，从而不写状态。
   *
   * @returns {Promise<void>}
   */
  async function stop() {
    stopped = true;
    if (timer !== null) {
      unregisterInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    tick,
    getStatus() {
      return {
        started,
        stopped,
        scheduled: timer !== null,
        intervalMs: delay,
        allowModel,
        ticks,
        busy: Boolean(running),
        lastCode,
        lastPassId: lastResult?.passId || '',
      };
    },
  };
}
