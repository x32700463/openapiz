import { generateId, CORS_HEADERS } from './utils.js';
import { createAnthropicToOpenAIStream, detectAnthropicFormat } from './convert.js';
import { ZEN_API_BASE } from './config.js';

/**
 * Build a Zen API request configuration.
 */
export function buildZenRequest(model, messages, stream, tools, toolChoice) {
  const body = { model, messages, stream: !!stream };
  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const requestId = generateId('msg');
  const sessionId = generateId('ses');

  return {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer public',
      'User-Agent': 'opencode/1.15.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13',
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
      'x-opencode-request': requestId,
      'x-opencode-session': sessionId,
    },
  };
}

/**
 * Helper: create a ReadableStream from a reader with a pre-read first chunk.
 */
function createReadableFromReader(firstResult, reader) {
  let firstUsed = false;
  return new ReadableStream({
    pull(controller) {
      if (!firstUsed) {
        firstUsed = true;
        if (firstResult.value) controller.enqueue(firstResult.value);
        if (firstResult.done) { controller.close(); return; }
      }
      return reader.read().then(({ done, value }) => {
        if (done) controller.close();
        else controller.enqueue(value);
      });
    },
    cancel() {
      reader.cancel();
    },
  });
}

/**
 * Proxy a chat completion request to the Zen API.
 *
 * Automatically detects if Zen returns Anthropic SSE (some models do this
 * even when called with OpenAI format) and converts to OpenAI SSE.
 */
export async function proxyToZen(options) {
  const response = await fetch(`${ZEN_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: options.headers,
    body: options.body,
  });

  const contentType = response.headers.get('content-type') || '';

  // Non-streaming JSON → return as-is
  if (!contentType.includes('text/event-stream')) {
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Streaming SSE
  const reader = response.body.getReader();
  const first = await reader.read();

  if (first.done) {
    return new Response('', {
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/event-stream' },
    });
  }

  const needsConversion = detectAnthropicFormat(first.value);

  if (!needsConversion) {
    // Passthrough OpenAI SSE → return rest of stream as-is
    const stream = createReadableFromReader(first, reader);
    return new Response(stream, {
      status: response.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Anthropic SSE → convert to OpenAI SSE on-the-fly
  const converter = createAnthropicToOpenAIStream();
  const upstream = createReadableFromReader(first, reader);

  // Pipe upstream into converter (background)
  upstream.pipeTo(converter.writable).catch(() => {});

  return new Response(converter.readable, {
    status: response.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
