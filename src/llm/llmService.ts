import { DorsalConfig } from '../config';
import { LlamaCppProvider } from './llamaCppProvider';
import { ChatMessage, ChatOptions, InfillOptions, LlmProvider } from './types';

export class LlmService {
	private provider: LlmProvider;

	constructor(config: DorsalConfig, private readonly log: (message: string) => void) {
		this.provider = LlmService.buildProvider(config, log);
	}

	private static buildProvider(config: DorsalConfig, log: (message: string) => void): LlmProvider {
		return new LlamaCppProvider(config.llamaCpp.baseUrl, config.llamaCpp.apiKey, config.llamaCpp.model, log);
	}

	reload(config: DorsalConfig): void {
		this.provider = LlmService.buildProvider(config, this.log);
	}

	getActiveProviderName(): string {
		return this.provider.name;
	}

	async infill(prefix: string, suffix: string, options: InfillOptions): Promise<string> {
		try {
			return await this.provider.infill(prefix, suffix, options);
		} catch (err) {
			this.log(`${this.provider.name} infill failed: ${String(err)}`);
			throw err;
		}
	}

	async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
		try {
			return await this.provider.chat(messages, options);
		} catch (err) {
			this.log(`${this.provider.name} chat failed: ${String(err)}`);
			throw err;
		}
	}
}
