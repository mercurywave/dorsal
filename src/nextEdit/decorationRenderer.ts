import * as vscode from 'vscode';

// Shared by both Next Edit Suggestions and inline quick-edit previews.
const removedDecorationType = vscode.window.createTextEditorDecorationType({
	textDecoration: 'line-through',
	backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
});

const addedDecorationType = vscode.window.createTextEditorDecorationType({
	after: {
		color: new vscode.ThemeColor('editorGhostText.foreground'),
		margin: '0 0 0 1em',
		fontStyle: 'italic',
	},
});

// Decorations can't render literal multi-line "after" content, so multi-line replacements
// are joined with a visible line-break glyph for the preview.
export function renderSuggestion(editor: vscode.TextEditor, range: vscode.Range, replacementText: string): void {
	editor.setDecorations(removedDecorationType, [range]);
	const preview = replacementText.split('\n').join(' ⏎ ');
	editor.setDecorations(addedDecorationType, [{
		range: new vscode.Range(range.end, range.end),
		renderOptions: { after: { contentText: ` → ${preview}` } },
	}]);
}

export function clearSuggestionDecorations(editor: vscode.TextEditor): void {
	editor.setDecorations(removedDecorationType, []);
	editor.setDecorations(addedDecorationType, []);
}
