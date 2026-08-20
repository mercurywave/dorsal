import * as vscode from 'vscode';
import { LlmService } from '../llm/llmService';
import { buildRecentEditContext, NextEditService, NextEditSuggestion, RecentEditContext } from './nextEditService';
import { NEXT_EDIT_STRATEGIES } from './nextEditStrategies';

export interface NextEditBenchmarkScenario {
	name: string;
	documentText: string;
	recentEdit?: RecentEditContext;
}

export interface NextEditBenchmarkResult {
	strategy: string;
	attempts: number;
	averageMs: number;
	completeRate: number;
	parseableRate: number;
	lineNumberOkRate: number;
	suggestedRate: number;
	validSuggestionRate: number;
	completeCount: number;
	parseableCount: number;
	lineNumberOkCount: number;
	suggestedCount: number;
	validSuggestionCount: number;
	errorCount: number;
}

export interface NextEditGenerationMetrics {
	suggestion?: NextEditSuggestion;
	parseable: boolean;
	lineNumberOk: boolean;
	validSuggestion: boolean;
	error: boolean;
	elapsedMs: number;
}

function makeScenario(name: string, beforeText: string, afterText: string): NextEditBenchmarkScenario {
	const recentEdit = buildRecentEditContext(beforeText, afterText);
	return {
		name,
		documentText: afterText,
		recentEdit: recentEdit ?? undefined,
	};
}

export function getBenchmarkScenarios(): NextEditBenchmarkScenario[] {
	return [
		makeScenario(
			'rename-usage-consistency',
			[
				'const userName = "alice";',
				'const display = userName.toUpperCase();',
				'console.log(display);',
				'',
				'function render() {',
				'  return userName;',
				'}',
			].join('\n'),
			[
				'const userDisplayName = "alice";',
				'const display = userName.toUpperCase();',
				'console.log(display);',
				'',
				'function render() {',
				'  return userName;',
				'}',
			].join('\n'),
		),
		makeScenario(
			'missing-import-from-type-rename',
			[
				'import { register } from "./registry";',
				'',
				'const handler = register();',
				'handler.run();',
			].join('\n'),
			[
				'import { register } from "./registry";',
				'',
				'const handler = registerHandler();',
				'handler.run();',
			].join('\n'),
		),
		makeScenario(
			'rename-prop-and-match-object-literal',
			[
				'type User = { id: number; name: string };',
				'',
				'const user: User = { id: 1, name: "alice" };',
				'console.log(user.name);',
			].join('\n'),
			[
				'type User = { id: number; displayName: string };',
				'',
				'const user: User = { id: 1, name: "alice" };',
				'console.log(user.name);',
			].join('\n'),
		),
		makeScenario(
			'callback-arg-consistency',
			[
				'const items = [1, 2, 3];',
				'const doubled = items.map((value) => value * 2);',
				'const total = doubled.reduce((sum, value) => sum + value, 0);',
			].join('\n'),
			[
				'const items = [1, 2, 3];',
				'const doubled = items.map((item) => item * 2);',
				'const total = doubled.reduce((sum, value) => sum + value, 0);',
			].join('\n'),
		),
		makeScenario(
			'matching-return-value-and-caller',
			[
				'function getValue() {',
				'  return 42;',
				'}',
				'',
				'const value = getValue();',
				'console.log(value);',
			].join('\n'),
			[
				'function resolveValue() {',
				'  return 42;',
				'}',
				'',
				'const value = getValue();',
				'console.log(value);',
			].join('\n'),
		),
	];
}

export function summarizeBenchmarkResults(results: NextEditBenchmarkResult[], modelName?: string): string {
	const rows = results.map((result) => ({
		strategy: result.strategy,
		avgMs: `${result.averageMs.toFixed(1)} ms`,
		complete: `${result.completeCount}/${result.attempts} (${result.completeRate.toFixed(0)}%)`,
		parseable: `${result.parseableCount}/${result.attempts} (${result.parseableRate.toFixed(0)}%)`,
		suggested: `${result.suggestedCount}/${result.attempts} (${result.suggestedRate.toFixed(0)}%)`,
		lineNumberOk: `${result.lineNumberOkCount}/${result.attempts} (${result.lineNumberOkRate.toFixed(0)}%)`,
		valid: `${result.validSuggestionCount}/${result.attempts} (${result.validSuggestionRate.toFixed(0)}%)`,
	}));

	const strategyWidth = Math.max(...rows.map((row) => row.strategy.length), 'strategy'.length);
	const avgWidth = Math.max(...rows.map((row) => row.avgMs.length), 'avg ms'.length);
	const completeWidth = Math.max(...rows.map((row) => row.complete.length), 'complete'.length);
	const parseableWidth = Math.max(...rows.map((row) => row.parseable.length), 'parseable'.length);
	const suggestedWidth = Math.max(...rows.map((row) => row.suggested.length), 'suggested'.length);
	const lineNumberOkWidth = Math.max(...rows.map((row) => row.lineNumberOk.length), 'line # ok'.length);
	const validWidth = Math.max(...rows.map((row) => row.valid.length), 'valid'.length);

	const line = (strategy: string, avgMs: string, complete: string, parseable: string, suggested: string, lineNumberOk: string, valid: string): string => {
		return `${strategy.padEnd(strategyWidth)}  ${avgMs.padEnd(avgWidth)}  ${complete.padEnd(completeWidth)}  ${parseable.padEnd(parseableWidth)}  ${suggested.padEnd(suggestedWidth)}  ${lineNumberOk.padEnd(lineNumberOkWidth)}  ${valid.padEnd(validWidth)}`;
	};

	const header = line('strategy', 'avg ms', 'complete', 'parseable', 'suggested', 'line # ok', 'valid');
	const separator = line('-'.repeat(strategyWidth), '-'.repeat(avgWidth), '-'.repeat(completeWidth), '-'.repeat(parseableWidth), '-'.repeat(suggestedWidth), '-'.repeat(lineNumberOkWidth), '-'.repeat(validWidth));
	const body = rows.map((row) => line(row.strategy, row.avgMs, row.complete, row.parseable, row.suggested, row.lineNumberOk, row.valid)).join('\n');
	const summaryTitle = modelName ? `Next-edit strategy benchmark summary for ${modelName}:` : 'Next-edit strategy benchmark summary:';
	return [summaryTitle, header, separator, body].join('\n');
}

export function getStrategyOptions(): string[] {
	return Object.keys(NEXT_EDIT_STRATEGIES);
}

export async function runNextEditBenchmark(
	llmService: LlmService,
	attempts: number = 3,
	progress: (message: string) => void = () => undefined,
	modelOverride: string = '',
): Promise<NextEditBenchmarkResult[]> {
	progress('Warming model up...');
	try {
		await llmService.chat(
			[{ role: 'user', content: 'Reply with OK.' }],
			{ maxTokens: 8, model: modelOverride, temperature: 0.1, timeoutMs: 15_000 },
			'nextEdit',
		);
	} catch (error) {
		const message = `Warm-up failed: ${error instanceof Error ? error.message : String(error)}`;
		progress(message);
		throw new Error(message);
	}

	const service = new NextEditService(llmService, () => undefined);
	const scenarios = getBenchmarkScenarios();
	const strategyIds = getStrategyOptions();
	const statsByStrategy = new Map<string, {
		totalMs: number;
		completeCount: number;
		parseableCount: number;
		lineNumberOkCount: number;
		suggestedCount: number;
		validSuggestionCount: number;
		errorCount: number;
		attempts: number;
	}>();

	for (const strategyId of strategyIds) {
		statsByStrategy.set(strategyId, {
			totalMs: 0,
			completeCount: 0,
			parseableCount: 0,
			lineNumberOkCount: 0,
			suggestedCount: 0,
			validSuggestionCount: 0,
			errorCount: 0,
			attempts: 0,
		});
	}

	for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex++) {
		progress(`Benchmark round ${attemptIndex + 1}/${attempts}...`);
		for (const scenario of scenarios) {
			progress(`  scenario ${scenario.name}...`);
			const document = await buildBenchmarkDocument(scenario);
			for (const strategyId of strategyIds) {
				const evaluation = await service.evaluateStrategy(
					document,
					4096,
					modelOverride,
					200,
					scenario.recentEdit,
					undefined,
					undefined,
					strategyId,
				);
				const stats = statsByStrategy.get(strategyId)!;
				stats.attempts += 1;
				stats.totalMs += evaluation.elapsedMs;
				if (!evaluation.error) {
					stats.completeCount++;
				}
				if (evaluation.parseable) {
					stats.parseableCount++;
				}
				if (evaluation.suggestion !== undefined) {
					stats.suggestedCount++;
				}
				if (evaluation.lineNumberOk) {
					stats.lineNumberOkCount++;
				}
				if (evaluation.validSuggestion) {
					stats.validSuggestionCount++;
				}
				if (evaluation.error) {
					stats.errorCount++;
				}
			}
		}
	}

	const totalRuns = scenarios.length * attempts;
	return strategyIds.map((strategyId) => {
		const stats = statsByStrategy.get(strategyId)!;
		return {
			strategy: strategyId,
			attempts: stats.attempts,
			averageMs: stats.attempts === 0 ? 0 : stats.totalMs / stats.attempts,
			completeRate: stats.attempts === 0 ? 0 : (stats.completeCount / stats.attempts) * 100,
			parseableRate: stats.attempts === 0 ? 0 : (stats.parseableCount / stats.attempts) * 100,
			lineNumberOkRate: stats.attempts === 0 ? 0 : (stats.lineNumberOkCount / stats.attempts) * 100,
			suggestedRate: stats.attempts === 0 ? 0 : (stats.suggestedCount / stats.attempts) * 100,
			validSuggestionRate: stats.attempts === 0 ? 0 : (stats.validSuggestionCount / stats.attempts) * 100,
			completeCount: stats.completeCount,
			parseableCount: stats.parseableCount,
			lineNumberOkCount: stats.lineNumberOkCount,
			suggestedCount: stats.suggestedCount,
			validSuggestionCount: stats.validSuggestionCount,
			errorCount: stats.errorCount,
		};
	});
}

class BenchmarkTextDocument implements vscode.TextDocument {
	public readonly uri: vscode.Uri;
	public readonly fileName: string;
	public readonly isUntitled = true;
	public readonly languageId = 'plaintext';
	public readonly version = 1;
	public readonly isDirty = false;
	public readonly isClosed = false;
	public readonly eol = vscode.EndOfLine.LF;
	public readonly encoding = 'utf8';
	public readonly notebook = undefined;
	public readonly lineCount: number;
	private readonly content: string;
	private readonly lines: string[];
	private readonly lineStarts: number[];

	constructor(name: string, content: string) {
		this.uri = vscode.Uri.from({ scheme: 'dorsal-benchmark', path: `/${name}.txt` });
		this.fileName = `${name}.txt`;
		this.content = content;
		this.lines = splitLinesPreserveTrailingEmpty(content);
		this.lineStarts = computeLineStarts(content);
		this.lineCount = this.lines.length;
	}

	lineAt(positionOrLine: number | vscode.Position): vscode.TextLine {
		const position = typeof positionOrLine === 'number'
			? new vscode.Position(positionOrLine, 0)
			: this.validatePosition(positionOrLine);
		const lineNumber = position.line;
		const text = this.lines[lineNumber] ?? '';
		const start = this.lineStarts[lineNumber] ?? 0;
		const range = new vscode.Range(new vscode.Position(lineNumber, 0), new vscode.Position(lineNumber, text.length));
		return {
			lineNumber,
			text,
			range,
			rangeIncludingLineBreak: range,
			firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
			isEmptyOrWhitespace: /^\s*$/.test(text),
		};
	}

	getText(range?: vscode.Range): string {
		if (!range) {
			return this.content;
		}
		const safeRange = this.validateRange(range);
		return this.content.slice(this.offsetAt(safeRange.start), this.offsetAt(safeRange.end));
	}

	offsetAt(position: vscode.Position): number {
		const safePosition = this.validatePosition(position);
		const lineStart = this.lineStarts[safePosition.line] ?? 0;
		const lineLength = (this.lines[safePosition.line] ?? '').length;
		return lineStart + Math.max(0, Math.min(safePosition.character, lineLength));
	}

	positionAt(offset: number): vscode.Position {
		const safeOffset = Math.max(0, Math.min(offset, this.content.length));
		let lineIndex = 0;
		for (let index = 0; index < this.lineStarts.length; index++) {
			if (this.lineStarts[index] <= safeOffset) {
				lineIndex = index;
			} else {
				break;
			}
		}
		const lineStart = this.lineStarts[lineIndex] ?? 0;
		return new vscode.Position(lineIndex, safeOffset - lineStart);
	}

	getWordRangeAtPosition(_position: vscode.Position, _regex?: RegExp): vscode.Range | undefined {
		return undefined;
	}

	validateRange(range: vscode.Range): vscode.Range {
		const startLine = Math.max(0, Math.min(range.start.line, this.lineCount - 1));
		const endLine = Math.max(0, Math.min(range.end.line, this.lineCount - 1));
		const startCharacter = Math.max(0, Math.min(range.start.character, (this.lines[startLine] ?? '').length));
		const endCharacter = Math.max(0, Math.min(range.end.character, (this.lines[endLine] ?? '').length));
		return new vscode.Range(new vscode.Position(startLine, startCharacter), new vscode.Position(endLine, endCharacter));
	}

	validatePosition(position: vscode.Position): vscode.Position {
		const line = Math.max(0, Math.min(position.line, this.lineCount - 1));
		const lineLength = (this.lines[line] ?? '').length;
		const character = Math.max(0, Math.min(position.character, lineLength));
		return new vscode.Position(line, character);
	}

	save(): Thenable<boolean> {
		return Promise.resolve(true);
	}

	saveAs(_target: vscode.Uri): Thenable<boolean> {
		return Promise.resolve(true);
	}

	show(): void {
		// Intentionally blank: benchmark docs are never opened in the workspace.
	}

	hide(): void {
		// Intentionally blank: benchmark docs are never opened in the workspace.
	}
}

function splitLinesPreserveTrailingEmpty(content: string): string[] {
	if (content.length === 0) {
		return [''];
	}
	const lines = content.split(/\r\n|\r|\n/);
	return lines[lines.length - 1] === '' ? lines : lines;
}

function computeLineStarts(content: string): number[] {
	const starts = [0];
	for (let index = 0; index < content.length; index++) {
		const current = content[index];
		if (current === '\r') {
			if (content[index + 1] === '\n') {
				index += 1;
			}
			starts.push(index + 1);
		} else if (current === '\n') {
			starts.push(index + 1);
		}
	}
	return starts;
}

export async function buildBenchmarkDocument(scenario: NextEditBenchmarkScenario): Promise<vscode.TextDocument> {
	return new BenchmarkTextDocument(scenario.name, scenario.documentText);
}
