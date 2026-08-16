import * as vscode from 'vscode';

export interface DorsalConfig {
	llamaCpp: { baseUrl: string; apiKey: string; model: string };
	completions: { enabled: boolean; maxTokens: number; debounceMs: number };
	nextEditSuggestions: { enabled: boolean; autoTrigger: boolean; maxTokens: number };
	inlineEdit: { maxTokens: number };
}

export function readConfig(): DorsalConfig {
	const cfg = vscode.workspace.getConfiguration('dorsal');
	return {
		llamaCpp: {
			baseUrl: cfg.get<string>('llamaCpp.baseUrl', 'http://127.0.0.1:8080'),
			apiKey: cfg.get<string>('llamaCpp.apiKey', ''),
			model: cfg.get<string>('llamaCpp.model', ''),
		},
		completions: {
			enabled: cfg.get<boolean>('completions.enabled', true),
			maxTokens: cfg.get<number>('completions.maxTokens', 128),
			debounceMs: cfg.get<number>('completions.debounceMs', 250),
		},
		nextEditSuggestions: {
			enabled: cfg.get<boolean>('nextEditSuggestions.enabled', true),
			autoTrigger: cfg.get<boolean>('nextEditSuggestions.autoTrigger', true),
			maxTokens: cfg.get<number>('nextEditSuggestions.maxTokens', 512),
		},
		inlineEdit: {
			maxTokens: cfg.get<number>('inlineEdit.maxTokens', 1024),
		},
	};
}
