import * as vscode from 'vscode';
import { readConfig } from '../config';
import { LlmService } from '../llm/llmService';
import { clearSuggestionDecorations, renderSuggestion, SuggestionCodeLensProvider } from '../nextEdit/decorationRenderer';

const CONTEXT_KEY = 'dorsalInlineEditPreviewVisible';
const CONTEXT_LINES = 20;

const SYSTEM_PROMPT = 'You are a code editing assistant. The developer selected some code and gave an '
	+ 'instruction describing how to change it. Reply with ONLY the replacement code for the selection - '
	+ 'no explanations, no markdown code fences, and matching the surrounding indentation style.';

interface PendingEdit {
	editor: vscode.TextEditor;
	range: vscode.Range;
	replacementText: string;
}

export class InlineEditController implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private pending: PendingEdit | undefined;

	constructor(
		private readonly llmService: LlmService,
		private readonly log: (message: string) => void,
		private readonly codeLensProvider: SuggestionCodeLensProvider,
	) {
		this.disposables.push(
			vscode.commands.registerCommand('dorsal.inlineEdit', () => this.start()),
			vscode.commands.registerCommand('dorsal.acceptInlineEdit', () => this.accept()),
			vscode.commands.registerCommand('dorsal.cancelInlineEdit', () => this.cancel()),
			vscode.window.onDidChangeActiveTextEditor(() => this.cancel()),
		);
	}

	private start(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		this.cancel();

		const inputBox = vscode.window.createInputBox();
		inputBox.placeholder = 'Describe the edit... (Enter to submit, Esc to cancel)';
		inputBox.prompt = 'Dorsal inline edit';
		inputBox.onDidAccept(() => {
			const instruction = inputBox.value.trim();
			inputBox.hide();
			if (instruction) {
				void this.requestEdit(editor, instruction);
			}
		});
		inputBox.onDidHide(() => inputBox.dispose());
		inputBox.show();
	}

	private async requestEdit(editor: vscode.TextEditor, instruction: string): Promise<void> {
		const config = readConfig();
		const range = editor.selection.isEmpty
			? editor.document.lineAt(editor.selection.active.line).range
			: new vscode.Range(editor.selection.start, editor.selection.end);
		const selectedText = editor.document.getText(range);

		const startLine = Math.max(0, range.start.line - CONTEXT_LINES);
		const endLine = Math.min(editor.document.lineCount - 1, range.end.line + CONTEXT_LINES);
		const contextRange = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
		const surroundingCode = editor.document.getText(contextRange);

		const userPrompt = `Surrounding code:\n${surroundingCode}\n\nSelected code to change:\n${selectedText}\n\nInstruction: ${instruction}`;

		let response: string;
		try {
			response = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Dorsal: generating edit...' },
				() => this.llmService.chat(
					[
						{ role: 'system', content: SYSTEM_PROMPT },
						{ role: 'user', content: userPrompt },
					],
					{ maxTokens: config.inlineEdit.maxTokens, model: config.inlineEdit.model, thinkingBudget: config.inlineEdit.thinkingBudget },
					'inlineEdit',
				),
			);
		} catch (err) {
			this.log(`inline edit request failed: ${String(err)}`);
			void vscode.window.showErrorMessage('Dorsal: inline edit request failed. See the "Dorsal" output channel for details.');
			return;
		}

		const replacementText = stripCodeFences(response);
		if (!replacementText || editor !== vscode.window.activeTextEditor) {
			return;
		}

		this.pending = { editor, range, replacementText };
		renderSuggestion(editor, range, replacementText);
		this.codeLensProvider.show(editor.document.uri, range, {
			acceptCommand: 'dorsal.acceptInlineEdit',
			acceptTitle: '$(check) Accept Edit (Tab)',
			dismissCommand: 'dorsal.cancelInlineEdit',
		});
		void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
	}

	private async accept(): Promise<void> {
		if (!this.pending) {
			return;
		}
		const { editor, range, replacementText } = this.pending;
		try {
			await editor.edit((editBuilder) => {
				editBuilder.replace(range, replacementText);
			});
		} catch (err) {
			this.log(`failed to apply inline edit: ${String(err)}`);
		}
		this.clearPending();
	}

	private cancel(): void {
		this.clearPending();
	}

	private clearPending(): void {
		if (this.pending) {
			clearSuggestionDecorations(this.pending.editor);
		}
		this.pending = undefined;
		this.codeLensProvider.hide();
		void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
	}

	dispose(): void {
		this.clearPending();
		this.disposables.forEach((d) => d.dispose());
	}
}

// Models often wrap replies in a fence even when told not to; unwrap it defensively.
function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
	return fenceMatch ? fenceMatch[1] : trimmed;
}
