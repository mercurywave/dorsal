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
		lineNumberOk: `${result.lineNumberOkCount}/${result.attempts} (${result.lineNumberOkRate.toFixed(0)}%)`,
		suggested: `${result.suggestedCount}/${result.attempts} (${result.suggestedRate.toFixed(0)}%)`,
		valid: `${result.validSuggestionCount}/${result.attempts} (${result.validSuggestionRate.toFixed(0)}%)`,
	}));

	const strategyWidth = Math.max(...rows.map((row) => row.strategy.length), 'strategy'.length);
	const avgWidth = Math.max(...rows.map((row) => row.avgMs.length), 'avg ms'.length);
	const completeWidth = Math.max(...rows.map((row) => row.complete.length), 'complete'.length);
	const parseableWidth = Math.max(...rows.map((row) => row.parseable.length), 'parseable'.length);
	const lineNumberOkWidth = Math.max(...rows.map((row) => row.lineNumberOk.length), 'line # ok'.length);
	const suggestedWidth = Math.max(...rows.map((row) => row.suggested.length), 'suggested'.length);
	const validWidth = Math.max(...rows.map((row) => row.valid.length), 'valid'.length);

	const line = (strategy: string, avgMs: string, complete: string, parseable: string, lineNumberOk: string, suggested: string, valid: string): string => {
		return `${strategy.padEnd(strategyWidth)}  ${avgMs.padEnd(avgWidth)}  ${complete.padEnd(completeWidth)}  ${parseable.padEnd(parseableWidth)}  ${lineNumberOk.padEnd(lineNumberOkWidth)}  ${suggested.padEnd(suggestedWidth)}  ${valid.padEnd(validWidth)}`;
	};

	const header = line('strategy', 'avg ms', 'complete', 'parseable', 'line # ok', 'suggested', 'valid');
	const separator = line('-'.repeat(strategyWidth), '-'.repeat(avgWidth), '-'.repeat(completeWidth), '-'.repeat(parseableWidth), '-'.repeat(lineNumberOkWidth), '-'.repeat(suggestedWidth), '-'.repeat(validWidth));
	const body = rows.map((row) => line(row.strategy, row.avgMs, row.complete, row.parseable, row.lineNumberOk, row.suggested, row.valid)).join('\n');
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
	const results: NextEditBenchmarkResult[] = [];

	for (const strategyId of getStrategyOptions()) {
		let totalMs = 0;
		let completeCount = 0;
		let parseableCount = 0;
		let lineNumberOkCount = 0;
		let suggestedCount = 0;
		let validSuggestionCount = 0;
		let errorCount = 0;
		const totalRuns = scenarios.length * attempts;

		progress(`Benchmarking ${strategyId} (${scenarios.length} scenarios x ${attempts} runs)...`);
		for (const scenario of scenarios) {
			progress(`  scenario ${scenario.name}...`);
			const document = await buildBenchmarkDocument(scenario);
			for (let index = 0; index < attempts; index++) {
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
				totalMs += evaluation.elapsedMs;
				if (!evaluation.error) {
					completeCount++;
				}
				if (evaluation.parseable) {
					parseableCount++;
				}
				if (evaluation.suggestion !== undefined) {
					suggestedCount++;
				}
				if (evaluation.lineNumberOk) {
					lineNumberOkCount++;
				}
				if (evaluation.validSuggestion) {
					validSuggestionCount++;
				}
				if (evaluation.error) {
					errorCount++;
				}
			}
		}

		results.push({
			strategy: strategyId,
			attempts: totalRuns,
			averageMs: totalRuns === 0 ? 0 : totalMs / totalRuns,
			completeRate: totalRuns === 0 ? 0 : (completeCount / totalRuns) * 100,
			parseableRate: totalRuns === 0 ? 0 : (parseableCount / totalRuns) * 100,
			lineNumberOkRate: totalRuns === 0 ? 0 : (lineNumberOkCount / totalRuns) * 100,
			suggestedRate: totalRuns === 0 ? 0 : (suggestedCount / totalRuns) * 100,
			validSuggestionRate: totalRuns === 0 ? 0 : (validSuggestionCount / totalRuns) * 100,
			completeCount,
			parseableCount,
			lineNumberOkCount,
			suggestedCount,
			validSuggestionCount,
			errorCount,
		});
		progress(`Finished ${strategyId}: ${completeCount}/${totalRuns} complete, ${parseableCount}/${totalRuns} parseable, ${lineNumberOkCount}/${totalRuns} line # ok, ${suggestedCount}/${totalRuns} suggested, ${validSuggestionCount}/${totalRuns} valid, ${errorCount}/${totalRuns} errors`);
	}

	return results;
}

export async function buildBenchmarkDocument(scenario: NextEditBenchmarkScenario): Promise<vscode.TextDocument> {
	return await vscode.workspace.openTextDocument({
		language: 'plaintext',
		content: scenario.documentText,
	});
}
