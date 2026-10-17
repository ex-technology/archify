// Minimal LM Studio client over its OpenAI-compatible API (no dependencies).
// Streaming is used for every completion: local generations can take minutes,
// and a non-streamed request would hit Node's default headers timeout.

export const DEFAULT_BASE_URL = 'http://localhost:1234/v1';

const NON_CHAT_TYPES = new Set(['embeddings']);

export class LMStudioClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = 'lm-studio', fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  get headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
  }

  async #getJson(url) {
    const response = await this.fetch(url, { headers: this.headers });
    if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
    return response.json();
  }

  /**
   * List chat-capable models. Prefers LM Studio's native /api/v0/models, which
   * reports load state, and falls back to the OpenAI-compatible /v1/models.
   */
  async listModels() {
    const nativeUrl = this.baseUrl.replace(/\/v1$/, '') + '/api/v0/models';
    try {
      const { data } = await this.#getJson(nativeUrl);
      return data
        .filter((m) => !NON_CHAT_TYPES.has(m.type))
        .map((m) => ({ id: m.id, loaded: m.state === 'loaded', contextLength: m.loaded_context_length }));
    } catch {
      const { data } = await this.#getJson(`${this.baseUrl}/models`);
      return data.filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, loaded: undefined }));
    }
  }

  /** Use the requested model, else the first loaded chat model, else the first listed one. */
  async pickModel(requested) {
    let models;
    try {
      models = await this.listModels();
    } catch (error) {
      throw new Error(
        `Cannot reach LM Studio at ${this.baseUrl} (${error.cause?.code ?? error.message}). ` +
          'Start the server in LM Studio (Developer tab -> Start Server, or `lms server start`).',
      );
    }
    if (requested) return models.find((m) => m.id === requested) ?? { id: requested, loaded: undefined };
    const chosen = models.find((m) => m.loaded) ?? models[0];
    if (!chosen) throw new Error('LM Studio reports no chat models. Download or load one first.');
    return chosen;
  }

  /**
   * Stream one chat completion and return the assembled answer.
   * Reasoning tokens (reasoning_content / reasoning) are reported to onProgress
   * but never returned as content.
   */
  async chat({ model, messages, temperature, maxTokens, onProgress = () => {}, signal }) {
    const body = { model, messages, stream: true };
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LM Studio chat request failed: HTTP ${response.status} ${detail.slice(0, 500)}`);
    }

    let content = '';
    let reasoning = '';
    let finishReason = null;
    let buffer = '';
    const decoder = new TextDecoder();

    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      const event = JSON.parse(payload);
      if (event.error) throw new Error(`LM Studio error: ${event.error.message ?? JSON.stringify(event.error)}`);
      const choice = event.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (thought) {
        reasoning += thought;
        onProgress({ kind: 'reasoning', chars: reasoning.length });
      }
      if (delta.content) {
        content += delta.content;
        onProgress({ kind: 'content', chars: content.length });
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer.trim());

    return { content, reasoning, finishReason };
  }
}
