import * as vscode from 'vscode';
import { LlmService } from '../llm/llmService';
import { NextEditService, NextEditSuggestion, RecentEditContext } from './nextEditService';
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
	validSuggestionRate: number;
	completeCount: number;
	parseableCount: number;
	validSuggestionCount: number;
	errorCount: number;
}

export interface NextEditGenerationMetrics {
	suggestion?: NextEditSuggestion;
	parseable: boolean;
	validSuggestion: boolean;
	error: boolean;
	elapsedMs: number;
}

export function getBenchmarkScenarios(): NextEditBenchmarkScenario[] {
	return [
		{
			name: 'rename-usage-consistency',
			documentText: [
				'const userName = "alice";',
				'const display = userName.toUpperCase();',
				'console.log(display);',
				'',
				'function render() {',
				'  return userName;',
				'}',
			].join('\n'),
			recentEdit: {
				diff: '@@ -1,3 +1,3 @@\n-const userName = "alice";\n+const userDisplayName = "alice";',
				changedLineRanges: [{ start: 0, end: 2 }],
			},
		},
		{
			name: 'missing-import-from-type-rename',
			documentText: [
				'import { register } from "./registry";',
				'',
				'const handler = register();',
				'handler.run();',
			].join('\n'),
			recentEdit: {
				diff: '@@ -1,3 +1,3 @@\n-import { register } from "./registry";\n+import { registerHandler } from "./registry";',
				changedLineRanges: [{ start: 0, end: 2 }],
			},
		},
		{
			name: 'rename-prop-and-match-object-literal',
			documentText: [
				'type User = { id: number; name: string };',
				'',
				'const user: User = { id: 1, name: "alice" };',
				'console.log(user.name);',
			].join('\n'),
			recentEdit: {
				diff: '@@ -1,3 +1,3 @@\n-type User = { id: number; name: string };\n+type User = { id: number; displayName: string };',
				changedLineRanges: [{ start: 0, end: 2 }],
			},
		},
		{
			name: 'callback-arg-consistency',
			documentText: [
				'const items = [1, 2, 3];',
				'const doubled = items.map((value) => value * 2);',
				'const total = doubled.reduce((sum, value) => sum + value, 0);',
			].join('\n'),
			recentEdit: {
				diff: '@@ -1,3 +1,3 @@\n-const doubled = items.map((value) => value * 2);\n+const doubled = items.map((item) => item * 2);',
				changedLineRanges: [{ start: 1, end: 2 }],
			},
		},
		{
			name: 'matching-return-value-and-caller',
			documentText: [
				'function getValue() {',
				'  return 42;',
				'}',
				'',
				'const value = getValue();',
				'console.log(value);',
			].join('\n'),
			recentEdit: {
				diff: '@@ -1,4 +1,4 @@\n-function getValue() {\n-  return 42;\n-}\n+function resolveValue() {\n+  return 42;\n+}',
				changedLineRanges: [{ start: 0, end: 3 }],
			},
		},
	];
}

export function summarizeBenchmarkResults(results: NextEditBenchmarkResult[]): string {
	const rows = results.map((result) => ({
		strategy: result.strategy,
		avgMs: `${result.averageMs.toFixed(1)} ms`,
		complete: `${result.completeCount}/${result.attempts} (${result.completeRate.toFixed(0)}%)`,
		parseable: `${result.parseableCount}/${result.attempts} (${result.parseableRate.toFixed(0)}%)`,
		valid: `${result.validSuggestionCount}/${result.attempts} (${result.validSuggestionRate.toFixed(0)}%)`,
	}));

	const strategyWidth = Math.max(...rows.map((row) => row.strategy.length), 'strategy'.length);
	const avgWidth = Math.max(...rows.map((row) => row.avgMs.length), 'avg ms'.length);
	const completeWidth = Math.max(...rows.map((row) => row.complete.length), 'complete'.length);
	const parseableWidth = Math.max(...rows.map((row) => row.parseable.length), 'parseable'.length);
	const validWidth = Math.max(...rows.map((row) => row.valid.length), 'valid'.length);

	const line = (strategy: string, avgMs: string, complete: string, parseable: string, valid: string): string => {
		return `${strategy.padEnd(strategyWidth)}  ${avgMs.padEnd(avgWidth)}  ${complete.padEnd(completeWidth)}  ${parseable.padEnd(parseableWidth)}  ${valid.padEnd(validWidth)}`;
	};

	const header = line('strategy', 'avg ms', 'complete', 'parseable', 'valid');
	const separator = line('-'.repeat(strategyWidth), '-'.repeat(avgWidth), '-'.repeat(completeWidth), '-'.repeat(parseableWidth), '-'.repeat(validWidth));
	const body = rows.map((row) => line(row.strategy, row.avgMs, row.complete, row.parseable, row.valid)).join('\n');
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
			validSuggestionRate: totalRuns === 0 ? 0 : (validSuggestionCount / totalRuns) * 100,
			completeCount,
			parseableCount,
			validSuggestionCount,
			errorCount,
		});
		progress(`Finished ${strategyId}: ${completeCount}/${totalRuns} complete, ${parseableCount}/${totalRuns} parseable, ${validSuggestionCount}/${totalRuns} valid, ${errorCount}/${totalRuns} errors`);
	}

	return results;
}

export async function buildBenchmarkDocument(scenario: NextEditBenchmarkScenario): Promise<vscode.TextDocument> {
	return await vscode.workspace.openTextDocument({
		language: 'plaintext',
		content: scenario.documentText,
	});
}
