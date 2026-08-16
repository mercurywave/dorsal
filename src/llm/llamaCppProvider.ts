import { ChatMessage, ChatOptions, InfillOptions, LlmProvider } from './types';
import { fetchJson } from './http';

interface LlamaCppChatResponse {
	choices?: { message?: { content?: string } }[];
}

interface LlamaCppInfillResponse {
	content?: string;
}

export class LlamaCppProvider implements LlmProvider {
	readonly name = 'llama.cpp';

	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly model: string,
		private readonly log: (message: string) => void,
	) {}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.apiKey) {
			headers['Authorization'] = `Bearer ${this.apiKey}`;
		}
		return headers;
	}

	async infill(prefix: string, suffix: string, options: InfillOptions): Promise<string> {
		const res = await fetchJson(`${this.baseUrl}/infill`, {
			method: 'POST',
			headers: this.headers(),
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
		const res = await fetchJson(`${this.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({
				messages,
				max_tokens: options.maxTokens,
				temperature: options.temperature ?? 0.2,
				stop: options.stop,
				...((options.model || this.model) ? { model: options.model || this.model } : {}),
			}),
		}, 30_000);
		if (!res.ok) {
			throw new Error(`llama.cpp chat completion failed: ${res.status} ${res.statusText}: ${await res.text()}`);
		}
		const data = await res.json() as LlamaCppChatResponse;
		return data.choices?.[0]?.message?.content ?? '';
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
