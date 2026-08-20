import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { LlamaCppProvider, capCompletionMaxTokens } from '../llm/llamaCppProvider';
import { buildRecentEditContext, isSuggestionOnChangedLines, parseSuggestion } from '../nextEdit/nextEditService';
import { NEXT_EDIT_STRATEGIES, resolveNextEditStrategy } from '../nextEdit/nextEditStrategies';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('next-edit strategies', () => {
	test('keeps next-edit focused on chat-based strategies', () => {
		assert.ok(NEXT_EDIT_STRATEGIES.clownfish);
		assert.ok(NEXT_EDIT_STRATEGIES.tang);
		assert.ok(NEXT_EDIT_STRATEGIES.wrasse);
		assert.strictEqual('manta' in NEXT_EDIT_STRATEGIES, false);
		assert.strictEqual('parrotfish' in NEXT_EDIT_STRATEGIES, false);
		assert.strictEqual('butterflyfish' in NEXT_EDIT_STRATEGIES, false);
		assert.strictEqual('damselfish' in NEXT_EDIT_STRATEGIES, false);
	});

	test('caps completions output to a safe token budget', () => {
		assert.strictEqual(capCompletionMaxTokens(4096), 256);
		assert.strictEqual(capCompletionMaxTokens(32), 64);
		assert.strictEqual(capCompletionMaxTokens(128), 128);
	});

	test('aborts slow completions requests at the HTTP layer', async () => {
		const provider = new LlamaCppProvider('http://example.test', '', '', () => undefined);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => new Promise<Response>((resolve, reject) => {
			const signal = init?.signal;
			const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
			signal?.addEventListener('abort', onAbort, { once: true });
			setTimeout(() => {
				if (signal?.aborted) {
					return;
				}
				resolve(new Response(JSON.stringify({ choices: [{ text: 'done' }] }), { status: 200 }));
			}, 50);
		});
		try {
			await assert.rejects(() => provider.completions('prompt', { maxTokens: 128, timeoutMs: 1 }), /AbortError|aborted/i);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('treats suggestions on the most recent edit as invalid for benchmark counting', () => {
		const doc = new vscode.Range(0, 0, 0, 10);
		const recentEdit = { diff: '@@ -1 +1 @@', changedLineRanges: [{ start: 0, end: 0 }] };
		assert.strictEqual(isSuggestionOnChangedLines({ range: doc, replacementText: 'changed' }, recentEdit), true);
		assert.strictEqual(isSuggestionOnChangedLines({ range: new vscode.Range(1, 0, 1, 10), replacementText: 'other' }, recentEdit), false);
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

	test('covers all existing benchmark scenarios with the correct changed line ranges', () => {
		const scenarios = [
			{
				name: 'rename-usage-consistency',
				before: [
					'const userName = "alice";',
					'const display = userName.toUpperCase();',
					'console.log(display);',
					'',
					'function render() {',
					'  return userName;',
					'}',
				].join('\n'),
				after: [
					'const userDisplayName = "alice";',
					'const display = userName.toUpperCase();',
					'console.log(display);',
					'',
					'function render() {',
					'  return userName;',
					'}',
				].join('\n'),
				hunkHead: '@@ -1,1 +1,1 @@',
				changedLineRanges: [{ start: 0, end: 0 }],
			},
			{
				name: 'missing-import-from-type-rename',
				before: [
					'import { register } from "./registry";',
					'',
					'const handler = register();',
					'handler.run();',
				].join('\n'),
				after: [
					'import { register } from "./registry";',
					'',
					'const handler = registerHandler();',
					'handler.run();',
				].join('\n'),
				hunkHead: '@@ -3,1 +3,1 @@',
				changedLineRanges: [{ start: 2, end: 2 }],
			},
			{
				name: 'rename-prop-and-match-object-literal',
				before: [
					'type User = { id: number; name: string };',
					'',
					'const user: User = { id: 1, name: "alice" };',
					'console.log(user.name);',
				].join('\n'),
				after: [
					'type User = { id: number; displayName: string };',
					'',
					'const user: User = { id: 1, name: "alice" };',
					'console.log(user.name);',
				].join('\n'),
				hunkHead: '@@ -1,1 +1,1 @@',
				changedLineRanges: [{ start: 0, end: 0 }],
			},
			{
				name: 'callback-arg-consistency',
				before: [
					'const items = [1, 2, 3];',
					'const doubled = items.map((value) => value * 2);',
					'const total = doubled.reduce((sum, value) => sum + value, 0);',
				].join('\n'),
				after: [
					'const items = [1, 2, 3];',
					'const doubled = items.map((item) => item * 2);',
					'const total = doubled.reduce((sum, value) => sum + value, 0);',
				].join('\n'),
				hunkHead: '@@ -2,1 +2,1 @@',
				changedLineRanges: [{ start: 1, end: 1 }],
			},
			{
				name: 'matching-return-value-and-caller',
				before: [
					'function getValue() {',
					'  return 42;',
					'}',
					'',
					'const value = getValue();',
					'console.log(value);',
				].join('\n'),
				after: [
					'function resolveValue() {',
					'  return 42;',
					'}',
					'',
					'const value = getValue();',
					'console.log(value);',
				].join('\n'),
				hunkHead: '@@ -1,1 +1,1 @@',
				changedLineRanges: [{ start: 0, end: 0 }],
			},
		];

		for (const scenario of scenarios) {
			const result = buildRecentEditContext(scenario.before, scenario.after);
			assert.ok(result, scenario.name);
			assert.ok(result?.diff.includes(scenario.hunkHead), `${scenario.name}: expected ${scenario.hunkHead} but got ${result?.diff}`);
			assert.deepStrictEqual(result?.changedLineRanges, scenario.changedLineRanges, scenario.name);
		}
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
