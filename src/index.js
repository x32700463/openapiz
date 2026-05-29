import { MODELS, PROXY_VERSION } from './config.js';
import { authenticate } from './auth.js';
import { generateId, CORS_HEADERS, jsonResponse } from './utils.js';
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  createOpenAIToAnthropicStream,
} from './convert.js';
import { buildZenRequest, proxyToZen } from './zen.js';

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Public endpoints (no auth required)
    if (path === '/' || path === '/health') {
      return handleHealth();
    }

    // Auth required for API endpoints
    const auth = authenticate(request, env);
    if (!auth.authenticated) {
      return jsonResponse(401, {
        error: { message: 'Invalid API key' },
      });
    }

    // Route
    switch (path) {
      case '/v1/models':
        return handleModels();
      case '/v1/chat/completions':
        return handleChatCompletion(request);
      case '/v1/messages':
        return handleMessages(request);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

// ── Health ──────────────────────────────────────────────────────────

function handleHealth() {
  return jsonResponse(200, {
    status: 'ok',
    version: `v${PROXY_VERSION}`,
    models: MODELS.length,
    endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/models'],
    models_list: MODELS,
  });
}

// ── Models ──────────────────────────────────────────────────────────

function handleModels() {
  return jsonResponse(200, {
    object: 'list',
    data: MODELS.map(id => ({
      id,
      object: 'model',
      created: 1779000000,
      owned_by: 'opencode-free',
    })),
  });
}

// ── OpenAI Chat Completions ─────────────────────────────────────────

async function handleChatCompletion(request) {
  const body = await request.json();
  const { model, messages, stream, tools, tool_choice } = body;

  if (!MODELS.includes(model)) {
    return jsonResponse(400, {
      error: { message: `Unknown model: ${model}. Available: ${MODELS.join(', ')}` },
    });
  }

  const zenOpts = buildZenRequest(model, messages, stream, tools, tool_choice);

  if (stream) {
    return proxyToZen(zenOpts, true);
  }

  // Non-streaming
  const response = await fetch(
    'https://opencode.ai/zen/v1/chat/completions',
    {
      method: 'POST',
      headers: zenOpts.headers,
      body: zenOpts.body,
    }
  );

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();

  // Check if Zen returned SSE even for non-streaming request
  if (contentType.includes('text/event-stream') || rawText.includes('data: {')) {
    // Parse SSE manually
    let fullText = '';
    const lines = rawText.split('\n');
    for (const line of lines) {
      let payload;
      if (line.startsWith('data: ')) payload = line.slice(6).trim();
      else if (line.startsWith('data:')) payload = line.slice(5).trim();
      else continue;
      if (payload === '[DONE]' || payload === '') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.choices?.[0]?.delta?.content) {
          fullText += parsed.choices[0].delta.content;
        }
        // Handle Anthropic format
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          fullText += parsed.delta.text;
        }
      } catch {}
    }

    const result = {
      id: generateId('chatcmpl'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fullText },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return jsonResponse(200, result);
  }

  // Standard JSON response from Zen
  let data;
  try { data = JSON.parse(rawText); } catch {
    return jsonResponse(502, {
      error: { message: 'Invalid upstream response', type: 'upstream_error' },
    });
  }

  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ── Anthropic Messages ──────────────────────────────────────────────

async function handleMessages(request) {
  const body = await request.json();
  const { model, stream } = body;

  if (!MODELS.includes(model)) {
    return jsonResponse(400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: `Unknown model: ${model}. Available: ${MODELS.join(', ')}` },
    });
  }

  // Convert Anthropic request → OpenAI format
  const { messages, tools } = anthropicToOpenAI(body);
  const inputTokens = Math.floor(JSON.stringify({ messages }).length / 4);

  const zenOpts = buildZenRequest(model, messages, stream, tools, undefined);

  if (stream) {
    // Streaming: get OpenAI SSE from Zen, convert to Anthropic SSE
    const response = await fetch(
      'https://opencode.ai/zen/v1/chat/completions',
      {
        method: 'POST',
        headers: zenOpts.headers,
        body: zenOpts.body,
      }
    );

    const contentType = response.headers.get('content-type') || '';

    // Check for error
    if (!response.ok) {
      const errorText = await response.text();
      return new Response(errorText, {
        status: response.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const converter = createOpenAIToAnthropicStream(model);

    // If it's SSE, pipe through converter
    if (contentType.includes('text/event-stream') || response.headers.get('transfer-encoding')) {
      response.body.pipeTo(converter.writable).catch(() => {});
      return new Response(converter.readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Non-streaming JSON response
    const data = await response.json();
    const anthropicResp = openAIToAnthropic(data, model, inputTokens);
    return jsonResponse(200, anthropicResp);
  }

  // Non-streaming
  try {
    const response = await fetch(
      'https://opencode.ai/zen/v1/chat/completions',
      {
        method: 'POST',
        headers: zenOpts.headers,
        body: zenOpts.body,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try { errorData = JSON.parse(errorText); } catch { errorData = { message: errorText }; }
      return jsonResponse(response.status, {
        type: 'error',
        error: { type: 'upstream_error', message: errorData.error?.message || 'Upstream error' },
      });
    }

    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); } catch {
      return jsonResponse(502, {
        type: 'error',
        error: { type: 'upstream_error', message: 'Invalid upstream response' },
      });
    }

    const anthropicResp = openAIToAnthropic(data, model, inputTokens);
    return jsonResponse(200, anthropicResp);
  } catch (e) {
    return jsonResponse(502, {
      type: 'error',
      error: { type: 'upstream_error', message: e.message },
    });
  }
}
