import * as vscode from 'vscode';
import { DorsalConfig } from '../config';
import { LlamaCppProvider } from './llamaCppProvider';
import { ChatMessage, ChatOptions, InfillOptions, LlmProvider } from './types';

// Identifies which feature made a request, so the status bar can track success/error per-workflow.
export type Workflow = 'completions' | 'nextEdit' | 'inlineEdit';

export interface WorkflowStatusEvent {
	workflow: Workflow;
	status: 'success' | 'error';
}

export class LlmService {
	private provider: LlmProvider;
	private readonly statusEmitter = new vscode.EventEmitter<WorkflowStatusEvent>();
	readonly onDidChangeWorkflowStatus = this.statusEmitter.event;

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

	async checkHealth(): Promise<boolean> {
		return this.provider.checkHealth();
	}

	async infill(prefix: string, suffix: string, options: InfillOptions, workflow: Workflow): Promise<string> {
		try {
			const result = await this.provider.infill(prefix, suffix, options);
			this.statusEmitter.fire({ workflow, status: 'success' });
			return result;
		} catch (err) {
			this.log(`${this.provider.name} infill failed: ${String(err)}`);
			this.statusEmitter.fire({ workflow, status: 'error' });
			throw err;
		}
	}

	async chat(messages: ChatMessage[], options: ChatOptions, workflow: Workflow): Promise<string> {
		try {
			const result = await this.provider.chat(messages, options);
			this.statusEmitter.fire({ workflow, status: 'success' });
			return result;
		} catch (err) {
			this.log(`${this.provider.name} chat failed: ${String(err)}`);
			this.statusEmitter.fire({ workflow, status: 'error' });
			throw err;
		}
	}

	dispose(): void {
		this.statusEmitter.dispose();
	}
}
