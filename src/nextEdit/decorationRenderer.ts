import { diffArrays, diffChars } from 'diff';
import * as vscode from 'vscode';

// Shared by both Next Edit Suggestions and inline quick-edit previews.
// Whole-line decorations, used when a line has no 1:1 counterpart on the other side.
const removedLineDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
	textDecoration: 'line-through',
});

const addedLineDecorationType = vscode.window.createTextEditorDecorationType({
	after: {
		color: new vscode.ThemeColor('foreground'),
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
		margin: '0 0 0 1em',
		// `after.contentText` collapses newlines by default; smuggle in `white-space: pre` so multi-line blocks render.
		textDecoration: 'none; white-space: pre;',
	},
	isWholeLine: true,
});

// Inline (substring) decorations, used for lines paired up as "modified" so only the
// actually-changed portion is highlighted (e.g. a removed "// " prefix).
const removedInlineDecorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
	textDecoration: 'line-through',
});

const addedInlineDecorationType = vscode.window.createTextEditorDecorationType({
	after: {
		color: new vscode.ThemeColor('foreground'),
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
	},
});

// Marks the suggestion on the scrollbar overview ruler so it stays discoverable even
// while scrolled away; clicking the ruler mark natively jumps VS Code to that position.
const suggestionMarkerDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	overviewRulerColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
	overviewRulerLane: vscode.OverviewRulerLane.Full,
});

// Arrow shown at the top/bottom edge of the viewport pointing toward an off-screen
// suggestion, since decorations on the suggestion's own range are invisible until scrolled to.
// Colored (rather than plain codelens-gray text) so it draws the eye like a notification badge.
const offscreenIndicatorDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground'),
	before: {
		color: new vscode.ThemeColor('statusBarItem.warningForeground'),
		fontWeight: 'bold',
		margin: '0 1em 0 0',
	},
});

interface DiffOp {
	kind: 'context' | 'removed' | 'added';
	line: string;
}

// Line-level hunks via jsdiff's array diff (Myers algorithm over our line arrays),
// rather than a hand-rolled LCS table.
function diffLineOps(original: string[], replacement: string[]): DiffOp[] {
	const ops: DiffOp[] = [];
	for (const change of diffArrays(original, replacement)) {
		const kind = change.added ? 'added' : change.removed ? 'removed' : 'context';
		for (const line of change.value as string[]) {
			ops.push({ kind, line });
		}
	}
	return ops;
}

// Whether two lines are similar enough to render as a single character-diffed "modified"
// line, rather than unrelated lines that just happen to land at the same index. Without
// this, a wholesale rewrite (e.g. reformatted block) gets diffed position-by-position and
// renders as near-total noise across the whole range.
function isModifiedPair(oldLine: string, newLine: string): boolean {
	if (oldLine === newLine) {
		return true;
	}
	if (oldLine.trim().length === 0 || newLine.trim().length === 0) {
		return false;
	}
	const commonLen = diffChars(oldLine, newLine)
		.filter((part) => !part.added && !part.removed)
		.reduce((sum, part) => sum + part.value.length, 0);
	const longerLen = Math.max(oldLine.length, newLine.length);
	return commonLen / longerLen >= 0.4;
}

// Renders a character-level diff of one modified line, anchoring each added chunk of
// text at its actual position instead of lumping the whole changed span together -
// so e.g. two separate renamed identifiers on one line each highlight independently.
function renderModifiedLine(
	lineNo: number,
	oldLine: string,
	newLine: string,
	inlineRemoved: vscode.DecorationOptions[],
	inlineAdded: vscode.DecorationOptions[],
): void {
	let oldCol = 0;
	for (const part of diffChars(oldLine, newLine)) {
		if (part.removed) {
			const end = oldCol + part.value.length;
			inlineRemoved.push({ range: new vscode.Range(lineNo, oldCol, lineNo, end) });
			oldCol = end;
		} else if (part.added) {
			inlineAdded.push({
				range: new vscode.Range(lineNo, oldCol, lineNo, oldCol),
				renderOptions: { after: { contentText: part.value } },
			});
		} else {
			oldCol += part.value.length;
		}
	}
}

// Renders a real diff instead of squashing a whole range into one strike-through
// with a single-line ghost-text summary. Lines that line up 1:1 between a removed
// run and the following added run are treated as "modified" and diffed character
// by character, so e.g. uncommenting a block only highlights the removed "//".
export function renderSuggestion(editor: vscode.TextEditor, range: vscode.Range, replacementText: string): void {
	const originalLines = editor.document.getText(range).split('\n');
	const newLines = replacementText.split('\n');
	const ops = diffLineOps(originalLines, newLines);

	const removedRanges: vscode.Range[] = [];
	const blockAddedDecorations: vscode.DecorationOptions[] = [];
	const inlineRemovedDecorations: vscode.DecorationOptions[] = [];
	const inlineAddedDecorations: vscode.DecorationOptions[] = [];

	const addBlock = (anchorLine: number, lines: string[]) => {
		if (lines.length === 0) {
			return;
		}
		const anchor = editor.document.lineAt(Math.min(Math.max(anchorLine, 0), editor.document.lineCount - 1));
		blockAddedDecorations.push({
			range: new vscode.Range(anchor.range.end, anchor.range.end),
			renderOptions: { after: { contentText: lines.join('\n') } },
		});
	};

	let lineNumber = range.start.line;
	let idx = 0;
	while (idx < ops.length) {
		if (ops[idx].kind === 'context') {
			lineNumber++;
			idx++;
			continue;
		}

		const removedStartLine = lineNumber;
		const removedRun: string[] = [];
		while (idx < ops.length && ops[idx].kind === 'removed') {
			removedRun.push(ops[idx].line);
			lineNumber++;
			idx++;
		}
		const addedRun: string[] = [];
		while (idx < ops.length && ops[idx].kind === 'added') {
			addedRun.push(ops[idx].line);
			idx++;
		}

		const pairCount = Math.min(removedRun.length, addedRun.length);
		let k = 0;
		while (k < pairCount) {
			const lineNo = removedStartLine + k;
			const oldLine = removedRun[k];
			const newLine = addedRun[k];
			if (isModifiedPair(oldLine, newLine)) {
				renderModifiedLine(lineNo, oldLine, newLine, inlineRemovedDecorations, inlineAddedDecorations);
				k++;
				continue;
			}

			// Unrelated lines at this index: render as a plain block remove + block add instead
			// of a misleading character diff, grouping the whole dissimilar run together.
			const dissimilarStart = k;
			while (k < pairCount && !isModifiedPair(removedRun[k], addedRun[k])) {
				removedRanges.push(editor.document.lineAt(removedStartLine + k).range);
				k++;
			}
			addBlock(removedStartLine + k - 1, addedRun.slice(dissimilarStart, k));
		}

		for (let tailK = pairCount; tailK < removedRun.length; tailK++) {
			removedRanges.push(editor.document.lineAt(removedStartLine + tailK).range);
		}

		if (addedRun.length > pairCount) {
			const anchorLine = removedRun.length > 0 ? removedStartLine + removedRun.length - 1 : removedStartLine - 1;
			addBlock(anchorLine, addedRun.slice(pairCount));
		}
	}

	editor.setDecorations(removedLineDecorationType, removedRanges);
	editor.setDecorations(addedLineDecorationType, blockAddedDecorations);
	editor.setDecorations(removedInlineDecorationType, inlineRemovedDecorations);
	editor.setDecorations(addedInlineDecorationType, inlineAddedDecorations);
	editor.setDecorations(suggestionMarkerDecorationType, [range]);
}

export function clearSuggestionDecorations(editor: vscode.TextEditor): void {
	editor.setDecorations(removedLineDecorationType, []);
	editor.setDecorations(addedLineDecorationType, []);
	editor.setDecorations(removedInlineDecorationType, []);
	editor.setDecorations(addedInlineDecorationType, []);
	editor.setDecorations(suggestionMarkerDecorationType, []);
	clearOffscreenIndicator(editor);
}

// Renders a "▲/▼ N lines away — Tab to jump" hint on the nearest visible edge line
// when `suggestionLine` falls outside all of `visibleRanges`.
export function renderOffscreenIndicator(editor: vscode.TextEditor, suggestionLine: number, visibleRanges: readonly vscode.Range[]): void {
	if (visibleRanges.length === 0) {
		clearOffscreenIndicator(editor);
		return;
	}
	const firstVisibleLine = visibleRanges[0].start.line;
	const lastVisibleLine = visibleRanges[visibleRanges.length - 1].end.line;
	if (suggestionLine >= firstVisibleLine && suggestionLine <= lastVisibleLine) {
		clearOffscreenIndicator(editor);
		return;
	}

	const above = suggestionLine < firstVisibleLine;
	// Inset from the true edge line: the top line is often covered by the sticky-scroll
	// widget, and the bottom line can be partially clipped mid-scroll, hiding the decoration.
	const editorConfig = vscode.workspace.getConfiguration('editor', editor.document.uri);
	const topInset = editorConfig.get<boolean>('stickyScroll.enabled', true)
		? editorConfig.get<number>('stickyScroll.maxLineCount', 5)
		: 1;
	const edgeLine = above
		? Math.min(firstVisibleLine + topInset, lastVisibleLine)
		: Math.max(lastVisibleLine - 1, firstVisibleLine);
	const distance = above ? firstVisibleLine - suggestionLine : suggestionLine - lastVisibleLine;
	const arrow = above ? '▲' : '▼';
	const plural = distance === 1 ? '' : 's';
	editor.setDecorations(offscreenIndicatorDecorationType, [{
		range: editor.document.lineAt(Math.min(Math.max(edgeLine, 0), editor.document.lineCount - 1)).range,
		renderOptions: { before: { contentText: `${arrow} Dorsal suggestion ${distance} line${plural} ${above ? 'above' : 'below'} — Tab to jump` } },
	}]);
}

export function clearOffscreenIndicator(editor: vscode.TextEditor): void {
	editor.setDecorations(offscreenIndicatorDecorationType, []);
}

interface ActiveLens {
	uri: vscode.Uri;
	range: vscode.Range;
	acceptCommand: string;
	acceptTitle: string;
	dismissCommand: string;
}

// Surfaces clickable Accept/Dismiss actions above a pending suggestion, since the
// keybindings alone (Tab/Esc) aren't discoverable.
export class SuggestionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changeEmitter.event;
	private active: ActiveLens | undefined;

	show(uri: vscode.Uri, range: vscode.Range, options: { acceptCommand: string; acceptTitle: string; dismissCommand: string }): void {
		this.active = { uri, range, ...options };
		this.changeEmitter.fire();
	}

	hide(): void {
		if (!this.active) {
			return;
		}
		this.active = undefined;
		this.changeEmitter.fire();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (!this.active || this.active.uri.toString() !== document.uri.toString()) {
			return [];
		}
		const { range, acceptCommand, acceptTitle, dismissCommand } = this.active;
		return [
			new vscode.CodeLens(range, { title: acceptTitle, command: acceptCommand, arguments: [] }),
			new vscode.CodeLens(range, { title: '$(close) Dismiss', command: dismissCommand, arguments: [] }),
		];
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}
