import * as vscode from 'vscode';
import { readConfig } from './config';
import { DorsalInlineCompletionProvider } from './completions/inlineCompletionProvider';
import { InlineEditController } from './inlineEdit/inlineEditController';
import { LlmService } from './llm/llmService';
import { SuggestionCodeLensProvider } from './nextEdit/decorationRenderer';
import { NextEditController } from './nextEdit/nextEditController';
import { runNextEditBenchmark, summarizeBenchmarkResults } from './nextEdit/nextEditBenchmark';
import { DorsalStatusBar } from './statusBar';

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Dorsal', { log: true });
	const log = (message: string) => output.error(message);
	const verboseLog = (message: string) => output.debug(message);

	const llmService = new LlmService(readConfig(), log, verboseLog);
	const statusBar = new DorsalStatusBar(llmService, output);
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
		vscode.commands.registerCommand('dorsal.benchmarkNextEditStrategies', async () => {
			const attempts = 3;
			const benchmarkConfig = readConfig();
			const benchmarkLlmService = new LlmService(benchmarkConfig, () => undefined, () => undefined);
			const modelName = benchmarkConfig.nextEditSuggestions.model || benchmarkConfig.llmServer.model || 'default server model';
			output.show(true);
			output.appendLine(`Running next-edit benchmark for ${attempts} attempts per strategy.`);
			const results = await runNextEditBenchmark(
				benchmarkLlmService,
				attempts,
				(message) => {
					output.appendLine(message);
				},
				benchmarkConfig.nextEditSuggestions.model || benchmarkConfig.llmServer.model,
			);
			output.appendLine('');
			output.appendLine(summarizeBenchmarkResults(results, modelName));
		}),
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider),
		vscode.languages.registerCodeLensProvider({ pattern: '**' }, codeLensProvider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('dorsal')) {
				llmService.reload(readConfig());
				statusBar.resetErrors();
			}
		}),
	);
}

export function deactivate() {}
