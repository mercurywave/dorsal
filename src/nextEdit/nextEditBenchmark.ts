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

export function summarizeBenchmarkResults(results: NextEditBenchmarkResult[]): string {
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
	return ['Next-edit strategy benchmark summary:', header, separator, body].join('\n');
}

export function getStrategyOptions(): string[] {
	return Object.keys(NEXT_EDIT_STRATEGIES);
}

export async function runNextEditBenchmark(
	llmService: LlmService,
	attempts: number = 3,
	progress: (message: string) => void = () => undefined,
): Promise<NextEditBenchmarkResult[]> {
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
					'',
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

export async function buildBenchmarkDocument(scenario: NextEditBenchmarkScenario): Promise<vscode.TextDocument> {
	return await vscode.workspace.openTextDocument({
		language: 'plaintext',
		content: scenario.documentText,
	});
}
