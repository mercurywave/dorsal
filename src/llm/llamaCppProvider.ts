import { ChatMessage, ChatOptions, CompletionOptions, InfillOptions, LlmProvider } from './types';
import { fetchJson } from './http';

interface LlamaCppChatResponse {
	choices?: { message?: { content?: string } }[];
}

interface LlamaCppCompletionsResponse {
	choices?: { text?: string }[];
}

interface LlamaCppInfillResponse {
	content?: string;
}

export const MAX_COMPLETION_RESPONSE_TOKENS = 256;

export function capCompletionMaxTokens(value: number, max = MAX_COMPLETION_RESPONSE_TOKENS): number {
	if (!Number.isFinite(value)) {
		return max;
	}
	return Math.min(Math.max(value, 64), max);
}

export class LlamaCppProvider implements LlmProvider {
	readonly name = 'llama.cpp';

	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly model: string,
		private readonly log: (message: string) => void,
	) {}

	private headers(apiKey: string): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		return headers;
	}

	async infill(prefix: string, suffix: string, options: InfillOptions): Promise<string> {
		const baseUrl = options.baseUrl || this.baseUrl;
		const apiKey = options.apiKey || this.apiKey;
		const res = await fetchJson(`${baseUrl}/infill`, {
			method: 'POST',
			headers: this.headers(apiKey),
			body: JSON.stringify({
				input_prefix: prefix,
				input_suffix: suffix,
				n_predict: options.maxTokens,
				temperature: options.temperature ?? 0.2,
				stop: options.stop,
				...((options.model || this.model) ? { model: options.model || this.model } : {}),
			}),
		}, 15_000);
		if (!res.ok) {
			throw new Error(`llama.cpp /infill failed: ${res.status} ${res.statusText}: ${await res.text()}`);
		}
		const data = await res.json() as LlamaCppInfillResponse;
		return data.content ?? '';
	}

	async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
		const baseUrl = options.baseUrl || this.baseUrl;
		const apiKey = options.apiKey || this.apiKey;
		const res = await fetchJson(`${baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: this.headers(apiKey),
			body: JSON.stringify({
				messages,
				max_tokens: options.maxTokens,
				temperature: options.temperature ?? 0.2,
				stop: options.stop,
				...(options.thinkingBudget !== undefined ? { reasoning_budget: options.thinkingBudget, thinking_budget_tokens: options.thinkingBudget } : {}),
				...((options.model || this.model) ? { model: options.model || this.model } : {}),
			}),
		}, 60_000);
		if (!res.ok) {
			throw new Error(`llama.cpp chat completion failed: ${res.status} ${res.statusText}: ${await res.text()}`);
		}
		const data = await res.json() as LlamaCppChatResponse;
		return data.choices?.[0]?.message?.content ?? '';
	}

	async completions(prompt: string, options: CompletionOptions): Promise<string> {
		const baseUrl = options.baseUrl || this.baseUrl;
		const apiKey = options.apiKey || this.apiKey;
		const maxTokens = capCompletionMaxTokens(options.maxTokens);
		const res = await fetchJson(`${baseUrl}/v1/completions`, {
			method: 'POST',
			headers: this.headers(apiKey),
			body: JSON.stringify({
				prompt,
				max_tokens: maxTokens,
				temperature: options.temperature ?? 0.2,
				stop: options.stop,
				...((options.model || this.model) ? { model: options.model || this.model } : {}),
			}),
		}, 60_000);
		if (!res.ok) {
			throw new Error(`llama.cpp completion failed: ${res.status} ${res.statusText}: ${await res.text()}`);
		}
		const data = await res.json() as LlamaCppCompletionsResponse;
		return data.choices?.[0]?.text ?? '';
	}

	async checkHealth(): Promise<boolean> {
		try {
			const res = await fetchJson(`${this.baseUrl}/health`, { method: 'GET' }, 2_000);
			return res.ok;
		} catch (err) {
			this.log(`llama.cpp health check failed: ${String(err)}`);
			return false;
		}
	}
}
