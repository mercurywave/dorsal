import * as vscode from 'vscode';

export interface DorsalConfig {
	llmServer: { baseUrl: string; apiKey: string; model: string };
	completions: { enabled: boolean; useInfillApi: boolean; maxTokens: number; debounceMs: number; model: string; baseUrl: string; apiKey: string };
	nextEditSuggestions: { enabled: boolean; autoTrigger: boolean; maxTokens: number; model: string; thinkingBudget: number; baseUrl: string; apiKey: string };
	inlineEdit: { maxTokens: number; model: string; thinkingBudget: number; baseUrl: string; apiKey: string };
}

export function readConfig(): DorsalConfig {
	const cfg = vscode.workspace.getConfiguration('dorsal');
	return {
		llmServer: {
			baseUrl: cfg.get<string>('llmServer.baseUrl', 'http://127.0.0.1:8080'),
			apiKey: cfg.get<string>('llmServer.apiKey', ''),
			model: cfg.get<string>('llmServer.model', ''),
		},
		completions: {
			enabled: cfg.get<boolean>('completions.enabled', true),
			useInfillApi: cfg.get<boolean>('completions.useInfillApi', true),
			maxTokens: cfg.get<number>('completions.maxTokens', 128),
			debounceMs: cfg.get<number>('completions.debounceMs', 250),
			model: cfg.get<string>('completions.model', ''),
			baseUrl: cfg.get<string>('completions.baseUrl', ''),
			apiKey: cfg.get<string>('completions.apiKey', ''),
		},
		nextEditSuggestions: {
			enabled: cfg.get<boolean>('nextEditSuggestions.enabled', true),
			autoTrigger: cfg.get<boolean>('nextEditSuggestions.autoTrigger', true),
				maxTokens: cfg.get<number>('nextEditSuggestions.maxTokens', 4096),
			model: cfg.get<string>('nextEditSuggestions.model', ''),
			thinkingBudget: cfg.get<number>('nextEditSuggestions.thinkingBudget', 200),
			baseUrl: cfg.get<string>('nextEditSuggestions.baseUrl', ''),
			apiKey: cfg.get<string>('nextEditSuggestions.apiKey', ''),
		},
		inlineEdit: {
			maxTokens: cfg.get<number>('inlineEdit.maxTokens', 1024),
			model: cfg.get<string>('inlineEdit.model', ''),
			thinkingBudget: cfg.get<number>('inlineEdit.thinkingBudget', 200),
			baseUrl: cfg.get<string>('inlineEdit.baseUrl', ''),
			apiKey: cfg.get<string>('inlineEdit.apiKey', ''),
		},
	};
}
