import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { buildRecentEditContext, parseSuggestion } from '../nextEdit/nextEditService';
import { NEXT_EDIT_STRATEGIES, resolveNextEditStrategy } from '../nextEdit/nextEditStrategies';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('next-edit strategies', () => {
	test('includes the coral reef strategy set', () => {
		assert.ok(NEXT_EDIT_STRATEGIES.clownfish);
		assert.ok(NEXT_EDIT_STRATEGIES.tang);
		assert.ok(NEXT_EDIT_STRATEGIES.manta);
		assert.ok(NEXT_EDIT_STRATEGIES.parrotfish);
		assert.ok(NEXT_EDIT_STRATEGIES.butterflyfish);
		assert.ok(NEXT_EDIT_STRATEGIES.damselfish);
		assert.ok(NEXT_EDIT_STRATEGIES.wrasse);
	});

	test('resolves unknown strategy names to the default clownfish mode', () => {
		assert.strictEqual(resolveNextEditStrategy('unknown' as any), NEXT_EDIT_STRATEGIES.clownfish);
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

suite('buildRecentEditContext', () => {
	test('describes a replacement as removed and added text', () => {
		const result = buildRecentEditContext('const value = fetch(id);', 'const value = await fetch(id);');
		assert.ok(result);
		assert.ok(result?.diff.includes('-const value = fetch(id);'));
		assert.ok(result?.diff.includes('+const value = await fetch(id);'));
		assert.deepStrictEqual(result?.changedLineRanges, [{ start: 0, end: 0 }]);
	});

	test('preserves deletion-only edits', () => {
		const result = buildRecentEditContext('keep();\nremove();\nfinish();', 'keep();\nfinish();');
		assert.ok(result);
		assert.ok(result?.diff.includes('-remove();'));
		assert.deepStrictEqual(result?.changedLineRanges, [{ start: 1, end: 1 }]);
	});

	test('keeps distant changes in separate hunks', () => {
		const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n');
		const after = ['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'EIGHT'].join('\n');
		const result = buildRecentEditContext(before, after);
		assert.ok(result);
		assert.strictEqual((result?.diff.match(/@@ /g) ?? []).length, 2);
		assert.deepStrictEqual(result?.changedLineRanges, [
			{ start: 0, end: 0 },
			{ start: 7, end: 7 },
		]);
	});

	test('truncates a large edit diff', () => {
		const before = 'old\n';
		const after = Array.from({ length: 5000 }, (_, index) => `inserted ${index}`).join('\n');
		const result = buildRecentEditContext(before, after);
		assert.ok(result);
		assert.ok((result?.diff.length ?? 0) <= 12_025);
		assert.ok(result?.diff.endsWith('... diff truncated ...'));
	});
});
