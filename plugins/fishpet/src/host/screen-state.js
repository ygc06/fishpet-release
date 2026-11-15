/**
 * On-demand screen permission and small local capture budget.
 *
 * This file deliberately contains no capture code. It only persists whether
 * the owner allowed the companion to look at the current display, and keeps a
 * tiny local budget so a mistaken tool loop cannot turn into screen recording.
 *
 * @module dsh-fishpet-emotion/host/screen-state
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const SCREEN_STATE_SCHEMA_VERSION = 1;
export const SCREEN_CAPTURE_MIN_INTERVAL_MS = 30_000;
export const SCREEN_CAPTURE_DAILY_LIMIT = 24;

function localDayKey(now) {
  const date = new Date(Number(now));
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function defaultScreenState(now = Date.now(), enabled = false) {
  return {
    schemaVersion: SCREEN_STATE_SCHEMA_VERSION,
    enabled: enabled === true,
    day: localDayKey(now),
    usedToday: 0,
    lastCaptureAt: 0,
  };
}

export function normalizeScreenState(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defaultScreenState(now);
  }
  const day = localDayKey(now);
  const storedDay = typeof input.day === 'string' ? input.day : '';
  const sameDay = storedDay === day;
  return {
    schemaVersion: SCREEN_STATE_SCHEMA_VERSION,
    enabled: input.enabled === true,
    day,
    usedToday: sameDay
      ? Math.max(0, Math.min(
          SCREEN_CAPTURE_DAILY_LIMIT,
          Math.floor(Number(input.usedToday) || 0),
        ))
      : 0,
    lastCaptureAt: sameDay ? finiteTimestamp(input.lastCaptureAt) : 0,
  };
}

export function screenCaptureGate(state, now = Date.now()) {
  const value = normalizeScreenState(state, now);
  if (!value.enabled) {
    return {
      ok: false,
      reason: 'disabled',
      retryAt: 0,
      usedToday: value.usedToday,
      dailyLimit: SCREEN_CAPTURE_DAILY_LIMIT,
    };
  }
  if (value.usedToday >= SCREEN_CAPTURE_DAILY_LIMIT) {
    return {
      ok: false,
      reason: 'daily-limit',
      retryAt: 0,
      usedToday: value.usedToday,
      dailyLimit: SCREEN_CAPTURE_DAILY_LIMIT,
    };
  }
  const retryAt = value.lastCaptureAt > 0
    ? value.lastCaptureAt + SCREEN_CAPTURE_MIN_INTERVAL_MS
    : 0;
  if (retryAt > Number(now)) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAt,
      usedToday: value.usedToday,
      dailyLimit: SCREEN_CAPTURE_DAILY_LIMIT,
    };
  }
  return {
    ok: true,
    reason: 'ready',
    retryAt: 0,
    usedToday: value.usedToday,
    dailyLimit: SCREEN_CAPTURE_DAILY_LIMIT,
  };
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows may ignore POSIX modes; the file still stays under the user's DSH home.
  }
}

/**
 * @param {object} options
 * @param {string} options.file
 * @param {() => number} [options.clock]
 * @param {boolean} [options.defaultEnabled]
 */
export function createScreenState({
  file,
  clock = () => Date.now(),
  defaultEnabled = false,
} = {}) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new TypeError('screen state file is required');
  }
  let state;
  let captureInFlight = false;

  try {
    state = normalizeScreenState(
      JSON.parse(readFileSync(file, 'utf8')),
      Number(clock()),
    );
  } catch (error) {
    // A missing file may receive the install-time default. A corrupt file is
    // treated as a revoked permission and must fail closed.
    const missing = error && error.code === 'ENOENT';
    state = defaultScreenState(
      Number(clock()),
      missing && defaultEnabled === true,
    );
    try {
      writeJsonAtomic(file, state);
    } catch {
      state = defaultScreenState(Number(clock()), false);
    }
  }

  function persist() {
    try {
      writeJsonAtomic(file, state);
      return true;
    } catch {
      return false;
    }
  }

  function refreshDay(now = Number(clock())) {
    const next = normalizeScreenState(state, now);
    if (next.day !== state.day) {
      state = next;
      persist();
    }
  }

  return {
    enabled() {
      refreshDay();
      return state.enabled === true;
    },
    setEnabled(enabled, now = Number(clock())) {
      refreshDay(now);
      const previous = state;
      state = {
        ...state,
        enabled: enabled === true,
      };
      const persisted = persist();
      if (!persisted) state = previous;
      return {
        ...this.status(now),
        persisted,
      };
    },
    claim(now = Number(clock())) {
      refreshDay(now);
      if (captureInFlight) return { ok: false, reason: 'busy' };
      const gate = screenCaptureGate(state, now);
      if (!gate.ok) return gate;
      captureInFlight = true;
      return gate;
    },
    complete(now = Number(clock())) {
      captureInFlight = false;
      refreshDay(now);
      state = {
        ...state,
        usedToday: Math.min(SCREEN_CAPTURE_DAILY_LIMIT, state.usedToday + 1),
        lastCaptureAt: Math.floor(Number(now) || Number(clock())),
      };
      persist();
      return this.status(now);
    },
    cancel() {
      captureInFlight = false;
    },
    status(now = Number(clock())) {
      refreshDay(now);
      const gate = screenCaptureGate(state, now);
      return {
        schemaVersion: SCREEN_STATE_SCHEMA_VERSION,
        enabled: state.enabled === true,
        ready: state.enabled === true && gate.ok === true && !captureInFlight,
        reason: captureInFlight ? 'capturing' : gate.reason,
        usedToday: state.usedToday,
        dailyLimit: SCREEN_CAPTURE_DAILY_LIMIT,
        minIntervalSeconds: Math.floor(SCREEN_CAPTURE_MIN_INTERVAL_MS / 1000),
        lastCaptureAt: state.lastCaptureAt,
        retryAt: gate.retryAt,
      };
    },
  };
}
