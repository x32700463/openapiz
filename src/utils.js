// Generate IDs matching opencode format: prefix_hexTimestamp + random
export function generateId(prefix) {
  const ts = Date.now().toString(16);
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  // Convert to base64url without padding
  const rnd = btoa(String.fromCharCode(...array))
    .replace(/[+/=]/g, '')
    .slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
