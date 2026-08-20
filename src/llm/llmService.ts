import * as vscode from 'vscode';
import { DorsalConfig } from '../config';
import { LlamaCppProvider } from './llamaCppProvider';
import { ChatMessage, ChatOptions, CompletionOptions, InfillOptions, LlmProvider } from './types';

// Identifies which feature made a request, so the status bar can track success/error per-workflow.
export type Workflow = 'completions' | 'nextEdit' | 'inlineEdit';

export interface WorkflowStatusEvent {
	workflow: Workflow;
	status: 'success' | 'error';
}

export class LlmService {
	private provider: LlmProvider;
	private chatRequestId = 0;
	private readonly statusEmitter = new vscode.EventEmitter<WorkflowStatusEvent>();
	readonly onDidChangeWorkflowStatus = this.statusEmitter.event;

	constructor(
		config: DorsalConfig,
		private readonly log: (message: string) => void,
		private readonly verboseLog: (message: string) => void,
	) {
		this.provider = LlmService.buildProvider(config, log);
	}

	private static buildProvider(config: DorsalConfig, log: (message: string) => void): LlmProvider {
		return new LlamaCppProvider(config.llmServer.baseUrl, config.llmServer.apiKey, log);
	}

	private static requireRequestOptions<T extends { baseUrl?: string; apiKey?: string; model?: string }>(options: T): T & { baseUrl: string; apiKey: string; model: string } {
		if (typeof options.baseUrl !== 'string' || typeof options.apiKey !== 'string' || typeof options.model !== 'string') {
			throw new Error('LLM request options must include explicit baseUrl, apiKey, and model settings.');
		}
		return options as T & { baseUrl: string; apiKey: string; model: string };
	}

	reload(config: DorsalConfig): void {
		this.provider = LlmService.buildProvider(config, this.log);
	}

	getActiveProviderName(): string {
		return this.provider.name;
	}

	async checkHealth(): Promise<boolean> {
		return this.provider.checkHealth();
	}

	async infill(prefix: string, suffix: string, options: InfillOptions, workflow: Workflow): Promise<string> {
		const requestOptions = LlmService.requireRequestOptions(options);
		try {
			const result = await this.provider.infill(prefix, suffix, requestOptions);
			this.statusEmitter.fire({ workflow, status: 'success' });
			return result;
		} catch (err) {
			this.log(`${this.provider.name} infill failed: ${String(err)}`);
			this.statusEmitter.fire({ workflow, status: 'error' });
			throw err;
		}
	}

	async chat(messages: ChatMessage[], options: ChatOptions, workflow: Workflow): Promise<string> {
		const requestOptions = LlmService.requireRequestOptions(options);
		const requestId = ++this.chatRequestId;
		if (workflow !== 'completions') {
			this.verboseLog(`[chat ${requestId}] ${workflow} request messages:\n${JSON.stringify(messages, null, 2)}`);
		}
		try {
			const result = await this.provider.chat(messages, requestOptions);
			if (workflow !== 'completions') {
				this.verboseLog(`[chat ${requestId}] ${workflow} response:\n${result}`);
			}
			this.statusEmitter.fire({ workflow, status: 'success' });
			return result;
		} catch (err) {
			this.log(`${this.provider.name} chat failed: ${String(err)}`);
			this.statusEmitter.fire({ workflow, status: 'error' });
			throw err;
		}
	}

	async completions(prompt: string, options: CompletionOptions, workflow: Workflow): Promise<string> {
		const requestOptions = LlmService.requireRequestOptions(options);
		try {
			const result = await this.provider.completions(prompt, requestOptions);
			this.statusEmitter.fire({ workflow, status: 'success' });
			return result;
		} catch (err) {
			this.log(`${this.provider.name} completions failed: ${String(err)}`);
			this.statusEmitter.fire({ workflow, status: 'error' });
			throw err;
		}
	}

	dispose(): void {
		this.statusEmitter.dispose();
	}
}
