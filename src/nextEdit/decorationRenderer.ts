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

interface DiffOp {
	kind: 'context' | 'removed' | 'added';
	line: string;
}

// Plain LCS line diff. Inputs are small (a context window plus one replacement), so
// the O(n*m) table is cheap and gives a real hunk-based diff instead of an all-or-nothing swap.
function diffLines(original: string[], replacement: string[]): DiffOp[] {
	const n = original.length;
	const m = replacement.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = original[i] === replacement[j]
				? lcs[i + 1][j + 1] + 1
				: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (original[i] === replacement[j]) {
			ops.push({ kind: 'context', line: original[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			ops.push({ kind: 'removed', line: original[i] });
			i++;
		} else {
			ops.push({ kind: 'added', line: replacement[j] });
			j++;
		}
	}
	while (i < n) {
		ops.push({ kind: 'removed', line: original[i] });
		i++;
	}
	while (j < m) {
		ops.push({ kind: 'added', line: replacement[j] });
		j++;
	}
	return ops;
}

// Splits a pair of lines into an unchanged common prefix/suffix and the differing
// middle, so a modified line (e.g. a removed "// " prefix) highlights only that part.
function diffLineChars(oldLine: string, newLine: string): { prefixLen: number; oldMid: string; newMid: string } {
	const maxPrefix = Math.min(oldLine.length, newLine.length);
	let prefixLen = 0;
	while (prefixLen < maxPrefix && oldLine[prefixLen] === newLine[prefixLen]) {
		prefixLen++;
	}
	const maxSuffix = maxPrefix - prefixLen;
	let suffixLen = 0;
	while (suffixLen < maxSuffix
		&& oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]) {
		suffixLen++;
	}
	return {
		prefixLen,
		oldMid: oldLine.slice(prefixLen, oldLine.length - suffixLen),
		newMid: newLine.slice(prefixLen, newLine.length - suffixLen),
	};
}

// Renders a real diff instead of squashing a whole range into one strike-through
// with a single-line ghost-text summary. Lines that line up 1:1 between a removed
// run and the following added run are treated as "modified" and diffed character
// by character, so e.g. uncommenting a block only highlights the removed "//".
export function renderSuggestion(editor: vscode.TextEditor, range: vscode.Range, replacementText: string): void {
	const originalLines = editor.document.getText(range).split('\n');
	const newLines = replacementText.split('\n');
	const ops = diffLines(originalLines, newLines);

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
		for (let k = 0; k < pairCount; k++) {
			const lineNo = removedStartLine + k;
			const oldLine = removedRun[k];
			const { prefixLen, oldMid, newMid } = diffLineChars(oldLine, addedRun[k]);
			if (oldMid.length === 0 && newMid.length === 0) {
				continue;
			}
			const midEndCol = prefixLen + oldMid.length;
			if (oldMid.length > 0) {
				inlineRemovedDecorations.push({ range: new vscode.Range(lineNo, prefixLen, lineNo, midEndCol) });
			}
			if (newMid.length > 0) {
				inlineAddedDecorations.push({
					range: new vscode.Range(lineNo, midEndCol, lineNo, midEndCol),
					renderOptions: { after: { contentText: newMid } },
				});
			}
		}

		for (let k = pairCount; k < removedRun.length; k++) {
			removedRanges.push(editor.document.lineAt(removedStartLine + k).range);
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
}

export function clearSuggestionDecorations(editor: vscode.TextEditor): void {
	editor.setDecorations(removedLineDecorationType, []);
	editor.setDecorations(addedLineDecorationType, []);
	editor.setDecorations(removedInlineDecorationType, []);
	editor.setDecorations(addedInlineDecorationType, []);
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
