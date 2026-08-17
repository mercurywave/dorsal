import * as vscode from 'vscode';
import { readConfig } from '../config';
import { LlmService } from '../llm/llmService';
import { clearSuggestionDecorations, renderSuggestion, SuggestionCodeLensProvider } from './decorationRenderer';
import { buildRecentEditContext, NextEditService, NextEditSuggestion, RecentEditContext } from './nextEditService';

const AUTO_TRIGGER_IDLE_MS = 1500;
const CONTEXT_KEY = 'dorsalNextEditSuggestionVisible';

interface ActiveSuggestion {
	editor: vscode.TextEditor;
	suggestion: NextEditSuggestion;
}

interface PendingEditBurst {
	editor: vscode.TextEditor;
	baselineText: string;
}

export class NextEditController implements vscode.Disposable {
	private readonly service: NextEditService;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly documentSnapshots = new Map<string, string>();
	private current: ActiveSuggestion | undefined;
	private autoTriggerTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingEditBurst: PendingEditBurst | undefined;
	private requestSequence = 0;

	constructor(
		llmService: LlmService,
		private readonly log: (message: string) => void,
		private readonly codeLensProvider: SuggestionCodeLensProvider,
	) {
		this.service = new NextEditService(llmService, log);
		for (const document of vscode.workspace.textDocuments) {
			this.documentSnapshots.set(document.uri.toString(), document.getText());
		}

		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => this.onDidChangeTextDocument(event)),
			vscode.workspace.onDidOpenTextDocument((document) => this.documentSnapshots.set(document.uri.toString(), document.getText())),
			vscode.workspace.onDidCloseTextDocument((document) => this.documentSnapshots.delete(document.uri.toString())),
			vscode.window.onDidChangeActiveTextEditor(() => {
				this.resetEditBurst();
				this.clearCurrentSuggestion();
			}),
			vscode.commands.registerCommand('dorsal.suggestNextEdit', () => this.triggerManual()),
			vscode.commands.registerCommand('dorsal.acceptNextEdit', () => this.accept()),
			vscode.commands.registerCommand('dorsal.dismissNextEditSuggestion', () => this.clearCurrentSuggestion()),
		);
	}

	private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
		this.clearCurrentSuggestion();
		this.requestSequence++;

		if (this.autoTriggerTimer) {
			clearTimeout(this.autoTriggerTimer);
			this.autoTriggerTimer = undefined;
		}

		const documentKey = event.document.uri.toString();
		const previousText = this.documentSnapshots.get(documentKey) ?? event.document.getText();
		this.documentSnapshots.set(documentKey, event.document.getText());

		const config = readConfig();
		if (!config.nextEditSuggestions.enabled || !config.nextEditSuggestions.autoTrigger || event.contentChanges.length === 0) {
			return;
		}
		// Undo and redo are history navigation, not new developer intent.
		if (event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo) {
			this.pendingEditBurst = undefined;
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document !== event.document) {
			return;
		}

		if (!this.pendingEditBurst || this.pendingEditBurst.editor !== editor) {
			this.pendingEditBurst = { editor, baselineText: previousText };
		}
		const baselineText = this.pendingEditBurst.baselineText;
		this.autoTriggerTimer = setTimeout(() => {
			this.autoTriggerTimer = undefined;
			this.pendingEditBurst = undefined;
			const recentEdit = buildRecentEditContext(baselineText, editor.document.getText());
			if (recentEdit) {
				void this.requestSuggestion(editor, recentEdit);
			}
		}, AUTO_TRIGGER_IDLE_MS);
	}

	private triggerManual(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		void this.requestSuggestion(editor);
	}

	private async requestSuggestion(editor: vscode.TextEditor, recentEdit?: RecentEditContext): Promise<void> {
		const config = readConfig();
		if (!config.nextEditSuggestions.enabled) {
			return;
		}
		const requestId = ++this.requestSequence;
		const documentVersion = editor.document.version;
		const suggestion = await this.service.suggest(
			editor.document,
			config.nextEditSuggestions.maxTokens,
			config.nextEditSuggestions.model,
			config.nextEditSuggestions.thinkingBudget,
			recentEdit,
			config.nextEditSuggestions.baseUrl,
			config.nextEditSuggestions.apiKey,
		);
		if (!suggestion
			|| requestId !== this.requestSequence
			|| editor.document.version !== documentVersion
			|| editor !== vscode.window.activeTextEditor) {
			return;
		}
		// A suggestion overlapping the recent edit would compete with the user's own change.
		if (recentEdit?.changedLineRanges.some((changedRange) =>
			suggestion.range.start.line <= changedRange.end && changedRange.start <= suggestion.range.end.line)) {
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

	private resetEditBurst(): void {
		if (this.autoTriggerTimer) {
			clearTimeout(this.autoTriggerTimer);
			this.autoTriggerTimer = undefined;
		}
		this.pendingEditBurst = undefined;
		this.requestSequence++;
	}

	dispose(): void {
		this.resetEditBurst();
		this.clearCurrentSuggestion();
		this.disposables.forEach((d) => d.dispose());
	}
}
