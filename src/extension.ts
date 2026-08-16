import * as vscode from 'vscode';
import { readConfig } from './config';
import { DorsalInlineCompletionProvider } from './completions/inlineCompletionProvider';
import { InlineEditController } from './inlineEdit/inlineEditController';
import { LlmService } from './llm/llmService';
import { SuggestionCodeLensProvider } from './nextEdit/decorationRenderer';
import { NextEditController } from './nextEdit/nextEditController';
import { DorsalStatusBar } from './statusBar';

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Dorsal');
	const log = (message: string) => output.appendLine(message);

	const llmService = new LlmService(readConfig(), log);
	const statusBar = new DorsalStatusBar(llmService);
	const completionProvider = new DorsalInlineCompletionProvider(llmService, log);
	const codeLensProvider = new SuggestionCodeLensProvider();
	const nextEditController = new NextEditController(llmService, log, codeLensProvider);
	const inlineEditController = new InlineEditController(llmService, log, codeLensProvider);

	context.subscriptions.push(
		output,
		statusBar,
		codeLensProvider,
		nextEditController,
		inlineEditController,
		vscode.commands.registerCommand('dorsal.showMenu', () => statusBar.showMenu()),
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider),
		vscode.languages.registerCodeLensProvider({ pattern: '**' }, codeLensProvider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('dorsal')) {
				llmService.reload(readConfig());
				statusBar.refresh();
			}
		}),
	);
}

export function deactivate() {}
