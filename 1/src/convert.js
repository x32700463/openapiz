import { generateId } from './utils.js';

/**
 * Convert Anthropic Messages API request body to OpenAI chat completion format.
 */
export function anthropicToOpenAI(body) {
  const messages = [];

  // System prompt
  if (body.system) {
    const sys = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => b.text || '').join('\n')
        : '';
    if (sys) messages.push({ role: 'system', content: sys });
  }

  // Convert messages
  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text);
      const toolUses = msg.content.filter(b => b.type === 'tool_use');
      const toolResults = msg.content.filter(b => b.type === 'tool_result');

      if (toolUses.length && msg.role === 'assistant') {
        // Assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: textParts.join('\n') || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: 'function',
            function: {
              name: t.name,
              arguments: JSON.stringify(t.input || {}),
            },
          })),
        });
      } else if (toolResults.length) {
        // Tool result messages
        for (const b of toolResults) {
          const resultText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map(c => c.text || '').join('\n')
              : '';
          messages.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: resultText,
          });
        }
      } else {
        messages.push({ role: msg.role, content: textParts.join('\n') });
      }
    }
  }

  // Convert tools
  const tools = (body.tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

/**
 * Convert OpenAI-style response to Anthropic Messages response (non-streaming).
 */
export function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: generateId('msg'),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model,
      stop_reason: 'end_turn',
      usage: { input_tokens: inputTokens || 0, output_tokens: 0,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id || generateId('toolu'),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  let stopReason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens';

  return {
    id: generateId('msg'),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Create a TransformStream that converts OpenAI SSE chunks to Anthropic SSE events.
 */
export function createOpenAIToAnthropicStream(model) {
  let buffer = '';
  let contentIndex = 0;
  let textBlockStarted = false;
  let messageStarted = false;
  let finished = false;

  function sendSSE(controller, event, data) {
    controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function startMessage(controller) {
    if (messageStarted) return;
    messageStarted = true;
    sendSSE(controller, 'message_start', {
      type: 'message_start',
      message: {
        id: generateId('msg'),
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0,
                 cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        // Send message_start on first data
        startMessage(controller);

        // Text content
        if (delta.content) {
          if (!textBlockStarted) {
            sendSSE(controller, 'content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
            textBlockStarted = true;
            contentIndex = 1;
          }
          sendSSE(controller, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta.content },
          });
        }

        // Reasoning content → also emit as text_delta
        if (delta.reasoning_content) {
          if (!textBlockStarted) {
            sendSSE(controller, 'content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
            textBlockStarted = true;
          }
          sendSSE(controller, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta.reasoning_content },
          });
        }

        // Finish
        if (parsed.choices?.[0]?.finish_reason && !finished) {
          finished = true;
          if (textBlockStarted) {
            sendSSE(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
          }
          const fr = parsed.choices[0].finish_reason;
          let stopReason = 'end_turn';
          if (fr === 'tool_calls') stopReason = 'tool_use';
          else if (fr === 'length') stopReason = 'max_tokens';

          sendSSE(controller, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason },
            usage: { output_tokens: 0 },
          });
          sendSSE(controller, 'message_stop', { type: 'message_stop' });
        }
      }
    },
    flush(controller) {
      if (messageStarted && !finished) {
        finished = true;
        if (textBlockStarted) {
          sendSSE(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        sendSSE(controller, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 0 },
        });
        sendSSE(controller, 'message_stop', { type: 'message_stop' });
      }
    },
  });
}

/**
 * Create a TransformStream that converts Anthropic SSE events to OpenAI SSE chunks.
 */
export function createAnthropicToOpenAIStream() {
  let buffer = '';
  let roleSent = false;
  let finished = false;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        let payload;
        if (line.startsWith('data: ')) payload = line.slice(6).trim();
        else if (line.startsWith('data:')) payload = line.slice(5).trim();
        else continue;
        if (payload === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }

        // Convert content_block_delta (text_delta) → OpenAI delta.content
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          const delta = {};
          if (!roleSent) { delta.role = 'assistant'; roleSent = true; }
          delta.content = parsed.delta.text;
          const chunkObj = {
            id: generateId('chatcmpl'),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: '',
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          controller.enqueue(`data: ${JSON.stringify(chunkObj)}\n\n`);
        }

        // Convert thinking_delta → reasoning_content
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
          const delta = {};
          if (!roleSent) { delta.role = 'assistant'; roleSent = true; }
          delta.reasoning_content = parsed.delta.thinking;
          const chunkObj = {
            id: generateId('chatcmpl'),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: '',
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          controller.enqueue(`data: ${JSON.stringify(chunkObj)}\n\n`);
        }

        // Convert message_delta → finish_reason + [DONE]
        if (parsed.type === 'message_delta' && !finished) {
          finished = true;
          const stopMap = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length' };
          const chunkObj = {
            id: generateId('chatcmpl'),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: '',
            choices: [{
              index: 0,
              delta: {},
              finish_reason: stopMap[parsed.delta?.stop_reason] || 'stop',
            }],
          };
          controller.enqueue(`data: ${JSON.stringify(chunkObj)}\n\n`);
          controller.enqueue('data: [DONE]\n\n');
        }
      }
    },
    flush(controller) {
      if (!finished) {
        const chunkObj = {
          id: generateId('chatcmpl'),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: '',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        controller.enqueue(`data: ${JSON.stringify(chunkObj)}\n\n`);
        controller.enqueue('data: [DONE]\n\n');
      }
    },
  });
}

/**
 * Detect if an SSE response is in Anthropic format based on the first chunk.
 */
export function detectAnthropicFormat(firstChunk) {
  const str = typeof firstChunk === 'string' ? firstChunk : new TextDecoder().decode(firstChunk);
  const lines = str.split('\n');
  for (const line of lines) {
    let payload;
    if (line.startsWith('data: ')) payload = line.slice(6).trim();
    else if (line.startsWith('data:')) payload = line.slice(5).trim();
    else continue;
    if (payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.type === 'message_start' || parsed.type === 'content_block_start' || parsed.type === 'ping') {
        return true;
      }
    } catch {}
  }
  return false;
}
