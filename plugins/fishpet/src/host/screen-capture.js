/**
 * Decode and privacy-gate the one frame supplied by the FishPet desktop app.
 *
 * The DSH Host never captures the desktop itself. Electron owns the OS capture
 * permission and posts a bounded JPEG back to the authenticated loopback bridge.
 *
 * @module dsh-fishpet-emotion/host/screen-capture
 */

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ACTIVITY_MAX_AGE_MS = 90_000;

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function decodeBase64(value) {
  const text = String(value || '').trim();
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw Object.assign(new Error('invalid-screen-image'), {
      code: 'invalid-screen-image',
    });
  }
  return Buffer.from(text, 'base64');
}

export function parseScreenCapture(stdout, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch {
    throw Object.assign(new Error('screen-capture-bad-json'), {
      code: 'screen-capture-bad-json',
    });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('screen-capture-empty'), {
      code: 'screen-capture-empty',
    });
  }
  const mediaType = String(parsed.mediaType || '').trim().toLowerCase();
  if (mediaType !== 'image/jpeg') {
    throw Object.assign(new Error('screen-capture-type'), {
      code: 'screen-capture-type',
    });
  }
  const width = Math.floor(Number(parsed.width));
  const height = Math.floor(Number(parsed.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)
    || width < 1 || height < 1 || width > 10_000 || height > 10_000) {
    throw Object.assign(new Error('screen-capture-dimensions'), {
      code: 'screen-capture-dimensions',
    });
  }
  const data = decodeBase64(parsed.data);
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES);
  if (data.length < 4 || data.length > maxBytes
    || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
    throw Object.assign(new Error('screen-capture-bytes'), {
      code: 'screen-capture-bytes',
    });
  }
  return { data, mediaType, width, height };
}

/**
 * Fail closed when the host cannot prove that the current foreground app is
 * safe to show. This uses the already-privacy-filtered activity fact; it never
 * inspects a title or process path itself.
 */
export function screenCaptureBlockReason(activity, now = Date.now()) {
  if (!activity || typeof activity !== 'object') return 'activity-unavailable';
  const sampledAt = Number(activity.sampledAt);
  if (!Number.isFinite(sampledAt) || sampledAt <= 0
    || sampledAt > Number(now) + 5_000
    || Number(now) - sampledAt > ACTIVITY_MAX_AGE_MS) {
    return 'activity-stale';
  }
  const state = String(activity.state || '').trim().toLowerCase();
  if (state === 'locked') return 'screen-locked';
  if (state === 'idle' && Number(activity.idleSec) >= 300) return 'user-away';
  if (state !== 'active') return 'activity-unavailable';
  const appId = String(activity.app?.id || '').trim().toLowerCase();
  const category = String(activity.app?.category || '').trim().toLowerCase();
  if (appId === 'private' || category === 'private') return 'private-app';
  return '';
}

