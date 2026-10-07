// @ts-check
/**
 * WebSocket client for the Paysecure AI gateway (claude-code-universal-client, `/v1/agent`).
 *
 * One GatewaySession = one gateway session = one Claude conversation that remembers earlier
 * turns, so a tester can refine generated cases step by step. Protocol v1:
 *   client → auth · session.open · user.message · session.close
 *   server → ready · session.ready · assistant.text · tool.use · turn.complete · error · session.closed
 *
 * The token is sent in the first `auth` frame (Node's WebSocket cannot set headers) and never logged.
 */
'use strict';

const GATEWAY_ERRORS = {
  unauthenticated: 'The AI gateway rejected the token – check AI_GATEWAY_TOKEN in .env',
  forbidden:
    'The AI gateway key is not allowed to do this – ask for a key with agent / chat access',
  seat_pool_saturated: 'The AI gateway is busy (all Claude seats in use) – try again in a minute',
  too_many_sessions:
    'The AI gateway key has too many open sessions – close other AI conversations and try again',
  quota_exceeded: 'The AI gateway daily quota for this key is used up',
  turn_timeout: 'The AI gateway took too long to answer – try fewer cases',
  model_not_allowed: 'The AI gateway key may not use this model – clear AI_GATEWAY_MODEL',
};

class GatewayError extends Error {
  /** @param {string} code @param {string} message @param {boolean} [retryable] */
  constructor(code, message, retryable = false) {
    super(GATEWAY_ERRORS[code] || `AI gateway error (${code}): ${message}`);
    this.code = code;
    this.retryable = retryable;
  }
}

/** http(s)://host:port/… or ws(s)://host:port/… → ws(s)://host:port/v1/agent */
function websocketUrl(raw) {
  const url = new URL(String(raw).trim());
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    throw new Error('AI_GATEWAY_URL must start with ws://, wss://, http:// or https://');
  if (!/\/v1\/agent\/?$/.test(url.pathname)) url.pathname = '/v1/agent';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function webSocketClass() {
  const impl = /** @type {any} */ (globalThis).WebSocket;
  if (typeof impl !== 'function')
    throw new Error('The AI gateway needs Node.js 22 or newer (built-in WebSocket)');
  return impl;
}

/** `error` frames that only warn (e.g. skill_pack_warning) – the session continues. */
const isWarning = (frame) => /_warning$/.test(String(frame.code || ''));

class GatewaySession {
  /**
   * @param {{url:string, token:string, mode:'chat'|'agent', skills?:string[], model?:string,
   *   disallowedTools?:string[], appendSystemPrompt?:string, connectTimeoutMs?:number}} options
   */
  static async open(options) {
    const session = new GatewaySession(options);
    await session.connect();
    return session;
  }

  constructor(options) {
    this.options = options;
    /** @type {any} */ this.ws = undefined;
    this.id = '';
    this.model = '';
    this.mode = options.mode;
    /** @type {string[]} */ this.skills = [];
    /** Non-fatal notices, e.g. skill_pack_warning "unknown skill pack". */
    /** @type {string[]} */ this.warnings = [];
    this.closed = false;
    /** @type {((frame:any)=>void) | undefined} */ this.listener = undefined;
    /** @type {((error:Error)=>void) | undefined} */ this.onDrop = undefined;
  }

  send(frame) {
    this.ws.send(JSON.stringify({ v: 1, ...frame }));
  }

  connect() {
    const WS = webSocketClass();
    const { url, token, connectTimeoutMs = 20_000 } = this.options;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.dispose();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('Could not reach the AI gateway (timeout) – check AI_GATEWAY_URL')),
        connectTimeoutMs,
      );
      const ws = new WS(url);
      this.ws = ws;
      ws.onopen = () => this.send({ type: 'auth', token });
      ws.onerror = () =>
        fail(new Error('Could not reach the AI gateway – check AI_GATEWAY_URL and the network'));
      ws.onclose = () => {
        this.closed = true;
        fail(new Error('The AI gateway closed the connection'));
        this.onDrop?.(new Error('The AI gateway closed the connection'));
      };
      ws.onmessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!settled) {
          if (frame.type === 'ready') {
            const o = this.options;
            this.send({
              type: 'session.open',
              req_id: 'open',
              mode: o.mode,
              ...(o.skills && o.skills.length ? { skills: o.skills } : {}),
              ...(o.model ? { model: o.model } : {}),
              ...(o.disallowedTools && o.disallowedTools.length
                ? { disallowed_tools: o.disallowedTools }
                : {}),
              ...(o.appendSystemPrompt ? { append_system_prompt: o.appendSystemPrompt } : {}),
            });
          } else if (frame.type === 'session.ready') {
            settled = true;
            clearTimeout(timer);
            this.id = String(frame.session || '');
            this.model = String(frame.model || '');
            this.mode = frame.mode || this.mode;
            this.skills = Array.isArray(frame.skills) ? frame.skills.map(String) : [];
            resolve(this);
          } else if (frame.type === 'error' && isWarning(frame)) {
            this.warnings.push(String(frame.message || frame.code));
          } else if (frame.type === 'error') {
            fail(
              new GatewayError(String(frame.code), String(frame.message || ''), !!frame.retryable),
            );
          }
          return;
        }
        this.listener?.(frame);
      };
    });
  }

  get usable() {
    return !this.closed && this.ws !== undefined && this.ws.readyState === 1;
  }

  /**
   * Sends one user message and waits for `turn.complete`.
   * @returns {Promise<{texts:string[], usage:{input:number, output:number}, costUsd:number|undefined, tools:string[]}>}
   */
  turn(text, timeoutMs = 240_000) {
    if (!this.usable) return Promise.reject(new Error('The AI gateway session has ended'));
    return new Promise((resolve, reject) => {
      const texts = [];
      const tools = [];
      const done = (fn) => {
        clearTimeout(timer);
        this.listener = undefined;
        this.onDrop = undefined;
        fn();
      };
      const timer = setTimeout(
        () => done(() => reject(new GatewayError('turn_timeout', 'no answer'))),
        timeoutMs,
      );
      this.onDrop = (error) => done(() => reject(error));
      this.listener = (frame) => {
        if (frame.type === 'assistant.text') texts.push(String(frame.text || ''));
        else if (frame.type === 'tool.use') tools.push(String(frame.name || ''));
        else if (frame.type === 'error' && isWarning(frame))
          this.warnings.push(String(frame.message || frame.code));
        else if (frame.type === 'error')
          done(() =>
            reject(
              new GatewayError(String(frame.code), String(frame.message || ''), !!frame.retryable),
            ),
          );
        else if (frame.type === 'turn.complete') {
          const u = frame.usage || {};
          done(() =>
            resolve({
              texts,
              tools,
              usage: {
                input:
                  (u.input_tokens || 0) +
                  (u.cache_creation_input_tokens || 0) +
                  (u.cache_read_input_tokens || 0),
                output: u.output_tokens || 0,
              },
              costUsd: typeof frame.cost_usd === 'number' ? frame.cost_usd : undefined,
            }),
          );
        }
      };
      this.send({ type: 'user.message', session_id: this.id, text });
    });
  }

  /** Ends the gateway session (frees the seat) and the socket. */
  close() {
    if (this.closed) return;
    try {
      if (this.id && this.ws?.readyState === 1)
        this.send({ type: 'session.close', session_id: this.id });
    } catch {
      /* already gone */
    }
    this.closed = true;
    const ws = this.ws;
    setTimeout(() => this.dispose(ws), 300).unref?.();
  }

  dispose(ws = this.ws) {
    try {
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    } catch {
      /* ignore */
    }
  }
}

module.exports = { GatewaySession, GatewayError, websocketUrl };
