/**
 * HTTP 守卫：Host / Origin / sec-fetch-site / 请求体上限 / Bearer。
 *
 * 这些检查 DSH 的 webServer 不会替我们做（插件裸路由完全不受鉴权，见第一轮报告 §7.2），
 * 所以必须在这里全部自己实现。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_BODY = 256 * 1024;

/** 解析 Host 头（可带端口），只接受回环值。 */
export function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  const raw = hostHeader.trim().toLowerCase();
  // [::1]:48720  /  [::1]
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return false;
    return raw.slice(0, end + 1) === '[::1]';
  }
  const host = raw.includes(':') ? raw.slice(0, raw.lastIndexOf(':')) : raw;
  return LOOPBACK_HOSTS.has(host);
}

/** Origin 可以缺失（原生客户端）；存在时必须是回环 http(s)。 */
export function originAllowed(originHeader) {
  if (originHeader === undefined || originHeader === null || originHeader === '') return true;
  let url;
  try {
    url = new URL(String(originHeader));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** 浏览器跨站请求一律拒绝。 */
export function crossSiteRejected(secFetchSite) {
  return String(secFetchSite ?? '').toLowerCase() === 'cross-site';
}

/**
 * 统一判定一个请求能否继续。返回 null 表示放行，否则返回 {status, code}。
 * 顺序固定：Host → Origin → cross-site → Bearer。
 */
export function screenRequest(req, token) {
  if (!hostAllowed(req.headers.host)) return { status: 403, code: 'forbidden-host' };
  if (!originAllowed(req.headers.origin)) return { status: 403, code: 'forbidden-origin' };
  if (crossSiteRejected(req.headers['sec-fetch-site'])) return { status: 403, code: 'cross-site' };
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    return { status: 401, code: 'unauthorized' };
  }
  const presented = Buffer.from(auth.slice(7).trim(), 'utf8');
  const expected = Buffer.from(String(token ?? ''), 'utf8');
  if (expected.length === 0) return { status: 401, code: 'unauthorized' };
  if (presented.length !== expected.length) return { status: 401, code: 'unauthorized' };
  // 常量时间比较，避免按字节早退泄露前缀。
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= presented[i] ^ expected[i];
  return diff === 0 ? null : { status: 401, code: 'unauthorized' };
}

/** 读 JSON 请求体，超过上限直接 413。 */
export function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const error = new Error('body-too-large');
      error.status = 413;
      error.code = 'body-too-large';
      // Keep draining so the route can still send the promised 413.
      req.resume();
      reject(error);
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      // Chunked clients have no Content-Length to reject before the first read.
      // Draining instead of destroying lets the route serialize its 413.
      req.resume();
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('body-too-large');
        error.status = 413;
        error.code = 'body-too-large';
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve(value && typeof value === 'object' ? value : {});
      } catch {
        const error = new Error('bad-json');
        error.status = 400;
        error.code = 'bad-json';
        reject(error);
      }
    });
  });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export { MAX_BODY };
