import * as vscode from 'vscode';
import { readConfig } from '../config';
import { LlmService } from '../llm/llmService';
import { clearSuggestionDecorations, renderSuggestion, SuggestionCodeLensProvider } from '../nextEdit/decorationRenderer';

const CONTEXT_KEY = 'dorsalInlineEditPreviewVisible';
const CONTEXT_LINES = 20;
const NO_SELECTION_EXPAND_LINES = 25;

const SELECTION_START_MARKER = '<<<START_EDIT>>>';
const SELECTION_END_MARKER = '<<<END_EDIT>>>';
const CURSOR_MARKER = '<<<CURSOR>>>';

const SYSTEM_PROMPT = 'You are a code editing assistant. The developer gave an instruction describing how to '
	+ `change some code. The code to change is marked in the surrounding code between ${SELECTION_START_MARKER} `
	+ `and ${SELECTION_END_MARKER}; reply with ONLY the full replacement for everything between those markers `
	+ '(including any unchanged lines), covering insertions, deletions, and edits anywhere in that range - no '
	+ `explanations, no markdown code fences, and matching the surrounding indentation style. A ${CURSOR_MARKER} `
	+ 'marker may also appear inside that range to show where the developer\'s cursor was; it is only a '
	+ 'reference point and edits are not limited to that exact spot.';

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
		const hasSelection = !editor.selection.isEmpty;
		const cursor = editor.selection.active;
		// With no selection, give the model a wide editable window around the cursor instead of
		// just the current line, so it can insert/delete code that isn't exactly at the cursor.
		const range = hasSelection
			? new vscode.Range(editor.selection.start, editor.selection.end)
			: expandToLineRange(editor.document, cursor.line - NO_SELECTION_EXPAND_LINES, cursor.line + NO_SELECTION_EXPAND_LINES);
		const targetText = editor.document.getText(range);

		const startLine = Math.max(0, range.start.line - CONTEXT_LINES);
		const endLine = Math.min(editor.document.lineCount - 1, range.end.line + CONTEXT_LINES);
		const contextRange = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);

		let markedLines = markRange(editor.document.getText(contextRange).split('\n'), range, startLine, SELECTION_START_MARKER, SELECTION_END_MARKER);
		if (!hasSelection) {
			markedLines = markPoint(markedLines, cursor, startLine, CURSOR_MARKER);
		}
		const markedSurroundingCode = markedLines.join('\n');

		const userPrompt = hasSelection
			? `Surrounding code (target marked between ${SELECTION_START_MARKER} and ${SELECTION_END_MARKER}):\n${markedSurroundingCode}\n\n`
				+ `Selected code to change:\n${targetText}\n\nInstruction: ${instruction}`
			: `Surrounding code (code to change marked between ${SELECTION_START_MARKER} and ${SELECTION_END_MARKER}; `
				+ `${CURSOR_MARKER} shows the developer's cursor for reference only):\n${markedSurroundingCode}\n\n`
				+ `Code to change:\n${targetText}\n\nInstruction: ${instruction}\n\n`
				+ 'Reply with the full replacement for the marked region, including any lines that should stay unchanged.';

		let response: string;
		try {
			response = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Dorsal: generating edit...' },
				() => this.llmService.chat(
					[
						{ role: 'system', content: SYSTEM_PROMPT },
						{ role: 'user', content: userPrompt },
					],
					{
						maxTokens: config.inlineEdit.maxTokens,
						model: config.inlineEdit.model,
						thinkingBudget: config.inlineEdit.thinkingBudget,
						baseUrl: config.inlineEdit.baseUrl,
						apiKey: config.inlineEdit.apiKey,
					},
					'inlineEdit',
				),
			);
		} catch (err) {
			this.log(`inline edit request failed: ${String(err)}`);
			void vscode.window.showErrorMessage('Dorsal: inline edit request failed. See the "Dorsal" output channel for details.');
			return;
		}

		const replacementText = normalizeLineEndings(stripCodeFences(response), editor.document.eol);
		if (!replacementText || editor !== vscode.window.activeTextEditor) {
			return;
		}
		// The first line of the widened (no-selection) region is ~25 lines from the cursor and
		// models often botch its indentation; keep the original rather than risk a bogus diff there.
		const finalReplacementText = hasSelection ? replacementText : keepFirstLineUnchanged(targetText, replacementText);

		this.pending = { editor, range, replacementText: finalReplacementText };
		renderSuggestion(editor, range, finalReplacementText);
		// With no selection, `range` can span dozens of lines around the cursor; anchor the
		// accept/dismiss lens at the cursor's line so it stays in view instead of scrolling off.
		const lensRange = hasSelection ? range : editor.document.lineAt(cursor.line).range;
		this.codeLensProvider.show(editor.document.uri, lensRange, {
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

// LLM output is plain LF; on a CRLF document every line would otherwise mismatch by
// its trailing \r alone, which breaks line-up-based diffing far past the actual edit.
function normalizeLineEndings(text: string, eol: vscode.EndOfLine): string {
	const lf = text.replace(/\r\n/g, '\n');
	return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, '\r\n') : lf;
}

// Forces the replacement's first line back to the original, since it's the line the
// model is most likely to misindent when it isn't near the cursor.
function keepFirstLineUnchanged(originalText: string, replacementText: string): string {
	const originalLines = originalText.split('\n');
	const replacementLines = replacementText.split('\n');
	if (originalLines.length === 0 || replacementLines.length === 0) {
		return replacementText;
	}
	replacementLines[0] = originalLines[0];
	return replacementLines.join('\n');
}

// Inserts start/end markers around `range` within `lines`, whose first entry corresponds to document line `baseLine`.
function markRange(lines: string[], range: vscode.Range, baseLine: number, startMarker: string, endMarker: string): string[] {
	const marked = [...lines];
	const startRel = range.start.line - baseLine;
	const endRel = range.end.line - baseLine;
	if (startRel === endRel) {
		const line = marked[startRel];
		marked[startRel] = line.slice(0, range.end.character) + endMarker + line.slice(range.end.character);
		marked[startRel] = marked[startRel].slice(0, range.start.character) + startMarker + marked[startRel].slice(range.start.character);
	} else {
		const endLine = marked[endRel];
		marked[endRel] = endLine.slice(0, range.end.character) + endMarker + endLine.slice(range.end.character);
		const startLine = marked[startRel];
		marked[startRel] = startLine.slice(0, range.start.character) + startMarker + startLine.slice(range.start.character);
	}
	return marked;
}

// Inserts a single marker at `position` within `lines`, whose first entry corresponds to document line `baseLine`.
function markPoint(lines: string[], position: vscode.Position, baseLine: number, marker: string): string[] {
	const marked = [...lines];
	const rel = position.line - baseLine;
	const line = marked[rel];
	marked[rel] = line.slice(0, position.character) + marker + line.slice(position.character);
	return marked;
}

// Builds a full-line range spanning `startLine` to `endLine` (inclusive), clamped to the document's bounds.
function expandToLineRange(document: vscode.TextDocument, startLine: number, endLine: number): vscode.Range {
	const clampedStart = Math.max(0, startLine);
	const clampedEnd = Math.min(document.lineCount - 1, endLine);
	return new vscode.Range(clampedStart, 0, clampedEnd, document.lineAt(clampedEnd).text.length);
}
