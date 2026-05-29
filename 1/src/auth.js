/**
 * Authenticate request using API keys from environment variable.
 *
 * API_KEYS env var 支持两种格式：
 *   - 简单字符串: "654321"  → 单个密钥
 *   - JSON 对象:  {"admin":"654321","user":"abc123"}  → 多用户
 *
 * 客户端在 Authorization header 中传密钥：
 *   Authorization: Bearer 654321
 *   或 x-api-key: 654321
 */
export function authenticate(request, env) {
  const hdr = request.headers.get('Authorization')
    || request.headers.get('x-api-key')
    || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;

  const raw = env.API_KEYS || '';

  // API_KEYS 为空 → 开放模式（不推荐生产使用）
  if (!raw) return { authenticated: true, user: 'default' };

  // API_KEYS 是简单字符串 → 直接比对
  if (!raw.startsWith('{')) {
    return token === raw
      ? { authenticated: true, user: 'default' }
      : { authenticated: false, user: null };
  }

  // API_KEYS 是 JSON 对象 → 遍历比对
  try {
    const apiKeys = JSON.parse(raw);
    for (const [name, key] of Object.entries(apiKeys)) {
      if (token === key) return { authenticated: true, user: name };
    }
  } catch {}

  return { authenticated: false, user: null };
}
