/**
 * DSH 认证边界内的看板只读路由。
 *
 * 不另造 token、端口或权限层：使用 `ctx.connection.fetch`，由 DSH 自己处理
 * Host/Origin、浏览器凭据与连接认证。路由只读快照，没有写方法。
 *
 * @module dsh-fishpet-emotion/host/dashboard-route
 */

export const DASHBOARD_ROUTE_PATH = '/api/fishpet-emotion.dashboard';

function responseHeaders() {
  return {
    'cache-control': 'no-store, max-age=0',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

/**
 * 注册看板路由。
 *
 * @param {object} ctx Cordis Host 上下文。
 * @param {{snapshot: () => Promise<object>, log?: (line: string) => void}} options
 * @returns {boolean} 是否注册成功。
 */
export function registerDashboardRoute(ctx, { snapshot, log = () => {} }) {
  const register = ctx?.connection?.fetch?.register;
  if (typeof register !== 'function') {
    try {
      log('[emotion] dashboard route unavailable: connection.fetch missing');
    } catch {
      /* 日志失败不影响插件 */
    }
    return false;
  }

  let dispose = null;
  try {
    dispose = register.call(ctx.connection.fetch, {
      path: DASHBOARD_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          request.signal.throwIfAborted();
          if (request.method !== 'GET') {
            return Response.json(
              { ok: false, code: 'method_not_allowed' },
              { status: 405, headers: responseHeaders() },
            );
          }
          const value = await snapshot();
          return Response.json(
            { ok: true, value },
            { status: 200, headers: responseHeaders() },
          );
        } catch (error) {
          if (request.signal.aborted) throw error;
          try {
            log(`[emotion] dashboard route failed: ${(error && error.name) || 'Error'}`);
          } catch {
            /* ignore */
          }
          return Response.json(
            { ok: false, code: 'dashboard_unavailable' },
            { status: 503, headers: responseHeaders() },
          );
        }
      },
    });
  } catch (error) {
    try {
      log(`[emotion] dashboard route registration failed: ${(error && error.name) || 'Error'}`);
    } catch {
      /* ignore */
    }
    return false;
  }

  if (typeof ctx.effect === 'function' && typeof dispose === 'function') {
    ctx.effect(() => () => {
      Promise.resolve(dispose()).catch(() => {});
    });
  }
  return true;
}

