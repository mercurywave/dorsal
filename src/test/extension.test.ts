import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { parseSuggestion } from '../nextEdit/nextEditService';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('parseSuggestion', () => {
	async function openDoc(content: string): Promise<vscode.TextDocument> {
		return vscode.workspace.openTextDocument({ content, language: 'plaintext' });
	}

	test('returns undefined for NONE response', async () => {
		const doc = await openDoc('line1\nline2\nline3');
		assert.strictEqual(parseSuggestion('NONE', doc), undefined);
	});

	test('returns undefined for unparseable response', async () => {
		const doc = await openDoc('line1\nline2\nline3');
		assert.strictEqual(parseSuggestion('not a valid response', doc), undefined);
	});

	test('parses a well-formed single-line edit', async () => {
		const doc = await openDoc('line1\nline2\nline3');
		const response = '<EDIT><START_LINE>2</START_LINE><END_LINE>2</END_LINE><REPLACEMENT>\nreplaced\n</REPLACEMENT></EDIT>';
		const result = parseSuggestion(response, doc);
		assert.ok(result);
		assert.strictEqual(result?.range.start.line, 1);
		assert.strictEqual(result?.range.end.line, 1);
		assert.strictEqual(result?.replacementText, 'replaced');
	});

	test('rejects an out-of-bounds line range', async () => {
		const doc = await openDoc('line1\nline2\nline3');
		const response = '<EDIT><START_LINE>1</START_LINE><END_LINE>99</END_LINE><REPLACEMENT>\nreplaced\n</REPLACEMENT></EDIT>';
		assert.strictEqual(parseSuggestion(response, doc), undefined);
	});
});
