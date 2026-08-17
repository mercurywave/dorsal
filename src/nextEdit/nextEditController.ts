import * as vscode from 'vscode';
import { readConfig } from '../config';
import { LlmService } from '../llm/llmService';
import { clearSuggestionDecorations, renderSuggestion, SuggestionCodeLensProvider } from './decorationRenderer';
import { NextEditService, NextEditSuggestion } from './nextEditService';

const AUTO_TRIGGER_IDLE_MS = 1500;
const CONTEXT_KEY = 'dorsalNextEditSuggestionVisible';

interface ActiveSuggestion {
	editor: vscode.TextEditor;
	suggestion: NextEditSuggestion;
}

export class NextEditController implements vscode.Disposable {
	private readonly service: NextEditService;
	private readonly disposables: vscode.Disposable[] = [];
	private current: ActiveSuggestion | undefined;
	private autoTriggerTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		llmService: LlmService,
		private readonly log: (message: string) => void,
		private readonly codeLensProvider: SuggestionCodeLensProvider,
	) {
		this.service = new NextEditService(llmService, log);

		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => this.onDidChangeTextDocument(event)),
			vscode.window.onDidChangeActiveTextEditor(() => this.clearCurrentSuggestion()),
			vscode.commands.registerCommand('dorsal.suggestNextEdit', () => this.triggerManual()),
			vscode.commands.registerCommand('dorsal.acceptNextEdit', () => this.accept()),
			vscode.commands.registerCommand('dorsal.dismissNextEditSuggestion', () => this.clearCurrentSuggestion()),
		);
	}

	private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
		this.clearCurrentSuggestion();

		if (this.autoTriggerTimer) {
			clearTimeout(this.autoTriggerTimer);
			this.autoTriggerTimer = undefined;
		}

		const config = readConfig();
		if (!config.nextEditSuggestions.enabled || !config.nextEditSuggestions.autoTrigger || event.contentChanges.length === 0) {
			return;
		}
		// Undo/redo and pure deletions aren't the user "typing"; only fresh input should
		// trigger a new suggestion.
		if (event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo) {
			return;
		}
		if (!event.contentChanges.some((change) => change.text.length > 0)) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document !== event.document) {
			return;
		}

		const changedLine = event.contentChanges[0].range.start.line;
		this.autoTriggerTimer = setTimeout(() => {
			void this.requestSuggestion(editor, changedLine);
		}, AUTO_TRIGGER_IDLE_MS);
	}

	private triggerManual(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		void this.requestSuggestion(editor, editor.selection.active.line);
	}

	private async requestSuggestion(editor: vscode.TextEditor, changedLine: number): Promise<void> {
		const config = readConfig();
		if (!config.nextEditSuggestions.enabled) {
			return;
		}
		const suggestion = await this.service.suggest(
			editor.document,
			changedLine,
			config.nextEditSuggestions.maxTokens,
			config.nextEditSuggestions.model,
			config.nextEditSuggestions.useInfillApi,
		);
		if (!suggestion || editor !== vscode.window.activeTextEditor) {
			return;
		}
		// A suggestion on the line just edited would overlap tab-completion and isn't useful.
		if (suggestion.range.start.line <= changedLine && changedLine <= suggestion.range.end.line) {
			return;
		}
		this.current = { editor, suggestion };
		renderSuggestion(editor, suggestion.range, suggestion.replacementText);
		this.codeLensProvider.show(editor.document.uri, suggestion.range, {
			acceptCommand: 'dorsal.acceptNextEdit',
			acceptTitle: '$(check) Accept Suggestion (Tab)',
			dismissCommand: 'dorsal.dismissNextEditSuggestion',
		});
		void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
	}

	private async accept(): Promise<void> {
		if (!this.current) {
			return;
		}
		const { editor, suggestion } = this.current;
		try {
			await editor.edit((editBuilder) => {
				editBuilder.replace(suggestion.range, suggestion.replacementText);
			});
		} catch (err) {
			this.log(`failed to apply next edit suggestion: ${String(err)}`);
		}
		this.clearCurrentSuggestion();
	}

	private clearCurrentSuggestion(): void {
		if (this.current) {
			clearSuggestionDecorations(this.current.editor);
		}
		this.current = undefined;
		this.codeLensProvider.hide();
		void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
	}

	dispose(): void {
		if (this.autoTriggerTimer) {
			clearTimeout(this.autoTriggerTimer);
		}
		this.clearCurrentSuggestion();
		this.disposables.forEach((d) => d.dispose());
	}
}
