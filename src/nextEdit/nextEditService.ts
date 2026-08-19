import * as vscode from 'vscode';
import { Change, diffLines } from 'diff';
import { LlmService } from '../llm/llmService';
import { resolveNextEditStrategy } from './nextEditStrategies';

export interface StrategyEvaluationResult {
	suggestion?: NextEditSuggestion;
	parseable: boolean;
	validSuggestion: boolean;
	error: boolean;
	elapsedMs: number;
}

export interface NextEditSuggestion {
	range: vscode.Range;
	replacementText: string;
}

export interface ChangedLineRange {
	start: number;
	end: number;
}

export interface RecentEditContext {
	diff: string;
	changedLineRanges: ChangedLineRange[];
}

const DIFF_CONTEXT_LINES = 2;
const MAX_DIFF_HUNKS = 8;
const MAX_DIFF_CHARS = 12_000;

// Requires a strict, machine-parseable response since model verbosity would otherwise
// be unreliable to parse into a concrete text edit.
const SYSTEM_PROMPT = 'You are a code editing assistant. Given a file (with 1-based line numbers) and a '
	+ 'diff showing the developer\'s recent changes, propose exactly one small follow-up edit elsewhere in the file that '
	+ 'keeps the code consistent (e.g. a matching usage, an import, or a related declaration). '
	+ 'Respond using EXACTLY this format and nothing else, with no markdown fences:\n'
	+ '<EDIT><START_LINE>n</START_LINE><END_LINE>n</END_LINE><REPLACEMENT>\ncode\n</REPLACEMENT></EDIT>\n'
	+ 'START_LINE and END_LINE are 1-based and inclusive, referring to the numbered lines shown to you. '
	+ 'REPLACEMENT is the full text that should replace those lines. '
	+ 'If no follow-up edit is needed, respond with exactly: NONE';

export class NextEditService {
	constructor(
		private readonly llmService: LlmService,
		private readonly log: (message: string) => void,
	) {}

	async evaluateStrategy(
		document: vscode.TextDocument,
		maxTokens: number,
		model: string,
		thinkingBudget: number,
		recentEdit?: RecentEditContext,
		baseUrl?: string,
		apiKey?: string,
		useInfillApi: boolean = true,
		strategyId: string = 'clownfish',
	): Promise<StrategyEvaluationResult> {
		const strategy = resolveNextEditStrategy(strategyId);
		const strategyRequest = strategy.buildRequest({
			document,
			recentEdit,
			options: { maxTokens, model, thinkingBudget, baseUrl, apiKey, useInfillApi },
		});
		const startedAt = Date.now();

		try {
			let response = '';
			if (strategyRequest.mode === 'chat' && strategyRequest.messages) {
				response = await this.llmService.chat(
					strategyRequest.messages,
					{ maxTokens, model, thinkingBudget, baseUrl, apiKey },
					'nextEdit',
				);
			} else if (strategyRequest.mode === 'infill' && strategyRequest.prefix !== undefined && strategyRequest.suffix !== undefined) {
				response = await this.llmService.infill(
					strategyRequest.prefix,
					strategyRequest.suffix,
					{ maxTokens, model, baseUrl, apiKey },
					'nextEdit',
				);
			} else if (strategyRequest.mode === 'completions' && strategyRequest.prompt !== undefined) {
				response = await this.llmService.completions(
					strategyRequest.prompt,
					{ maxTokens, model, baseUrl, apiKey },
					'nextEdit',
				);
			}

			const suggestion = strategy.parse(response, document, strategyRequest.targetRange);
			const parseable = response.trim().length > 0 && (suggestion !== undefined || response.trim().toUpperCase() === 'NONE');
			return {
				suggestion,
				parseable,
				validSuggestion: suggestion !== undefined,
				error: false,
				elapsedMs: Date.now() - startedAt,
			};
		} catch (err) {
			this.log(`next edit suggestion request failed: ${String(err)}`);
			return {
				suggestion: undefined,
				parseable: false,
				validSuggestion: false,
				error: true,
				elapsedMs: Date.now() - startedAt,
			};
		}
	}

	async suggest(
		document: vscode.TextDocument,
		maxTokens: number,
		model: string,
		thinkingBudget: number,
		recentEdit?: RecentEditContext,
		baseUrl?: string,
		apiKey?: string,
		useInfillApi: boolean = true,
		strategyId: string = 'clownfish',
	): Promise<NextEditSuggestion | undefined> {
		return (await this.evaluateStrategy(
			document,
			maxTokens,
			model,
			thinkingBudget,
			recentEdit,
			baseUrl,
			apiKey,
			useInfillApi,
			strategyId,
		)).suggestion;
	}
}

export function buildRecentEditContext(before: string, after: string): RecentEditContext | undefined {
	if (before === after) {
		return undefined;
	}

	const changes = diffLines(before, after);
	const operations = toLineOperations(changes);
	const changedOperationIndexes = operations
		.map((operation, index) => operation.kind === 'equal' ? -1 : index)
		.filter((index) => index >= 0);
	if (changedOperationIndexes.length === 0) {
		return undefined;
	}

	const groups: Array<{ start: number; end: number }> = [];
	for (const index of changedOperationIndexes) {
		const previous = groups[groups.length - 1];
		const unchangedLineGap = previous
			? operations.slice(previous.end + 1, index)
				.reduce((total, operation) => total + (operation.kind === 'equal' ? operation.lines.length : 0), 0)
			: Number.POSITIVE_INFINITY;
		if (previous && unchangedLineGap <= DIFF_CONTEXT_LINES * 2) {
			previous.end = index;
		} else {
			groups.push({ start: index, end: index });
		}
	}

	const hunks = groups.slice(0, MAX_DIFF_HUNKS).map((group) => {
		const start = Math.max(0, group.start - DIFF_CONTEXT_LINES);
		const end = Math.min(operations.length - 1, group.end + DIFF_CONTEXT_LINES);
		return renderHunk(operations.slice(start, end + 1));
	});
	const omittedHunks = groups.length - hunks.length;
	let diff = hunks.join('\n');
	if (omittedHunks > 0) {
		diff += `\n... ${omittedHunks} additional change hunk(s) omitted ...`;
	}
	if (diff.length > MAX_DIFF_CHARS) {
		diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...`;
	}

	return {
		diff,
		changedLineRanges: groups.slice(0, MAX_DIFF_HUNKS).map((group) => changedLineRange(operations, group)),
	};
}

interface LineOperation {
	kind: 'equal' | 'removed' | 'added';
	lines: string[];
	oldStart: number;
	newStart: number;
}

function toLineOperations(changes: Change[]): LineOperation[] {
	let oldLine = 1;
	let newLine = 1;
	return changes.map((change) => {
		const lines = splitLines(change.value);
		const operation: LineOperation = {
			kind: change.added ? 'added' : change.removed ? 'removed' : 'equal',
			lines,
			oldStart: oldLine,
			newStart: newLine,
		};
		if (!change.added) {
			oldLine += lines.length;
		}
		if (!change.removed) {
			newLine += lines.length;
		}
		return operation;
	});
}

function splitLines(value: string): string[] {
	const lines = value.split(/\r?\n/);
	return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function renderHunk(operations: LineOperation[]): string {
	const firstChanged = operations.findIndex((operation) => operation.kind !== 'equal');
	const lastChanged = operations.length - 1 - [...operations].reverse().findIndex((operation) => operation.kind !== 'equal');
	const start = Math.max(0, firstChanged - DIFF_CONTEXT_LINES);
	const end = Math.min(operations.length, lastChanged + DIFF_CONTEXT_LINES + 1);
	const visibleOperations = operations.slice(start, end).map((operation, index, visible) => {
		if (operation.kind !== 'equal') {
			return operation;
		}
		const first = index === 0;
		const last = index === visible.length - 1;
		if (!first && !last) {
			return operation;
		}
		const lines = first
			? operation.lines.slice(-DIFF_CONTEXT_LINES)
			: operation.lines.slice(0, DIFF_CONTEXT_LINES);
		const skippedLines = operation.lines.length - lines.length;
		return {
			...operation,
			lines,
			oldStart: operation.oldStart + skippedLines,
			newStart: operation.newStart + skippedLines,
		};
	});
	const oldLines = visibleOperations.flatMap((operation) => operation.kind === 'added' ? [] : operation.lines);
	const newLines = visibleOperations.flatMap((operation) => operation.kind === 'removed' ? [] : operation.lines);
	const oldStart = visibleOperations.find((operation) => operation.kind !== 'added')?.oldStart ?? visibleOperations[0].oldStart;
	const newStart = visibleOperations.find((operation) => operation.kind !== 'removed')?.newStart ?? visibleOperations[0].newStart;
	const body = visibleOperations.flatMap((operation) => operation.lines.map((line) => `${operation.kind === 'equal' ? ' ' : operation.kind === 'removed' ? '-' : '+'}${line}`));
	return `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@\n${body.join('\n')}`;
}

function changedLineRange(operations: LineOperation[], group: { start: number; end: number }): ChangedLineRange {
	const changed = operations.slice(group.start, group.end + 1).filter((operation) => operation.kind !== 'equal');
	const added = changed.filter((operation) => operation.kind !== 'removed');
	if (added.length === 0) {
		const operation = changed[0];
		const line = Math.max(1, operation.newStart) - 1;
		return { start: line, end: line };
	}
	const start = Math.min(...added.map((operation) => operation.newStart));
	const end = Math.max(...added.map((operation) => operation.newStart + operation.lines.length - 1));
	return { start: start - 1, end: Math.max(start - 1, end - 1) };
}

export const RESPONSE_PATTERN = /<EDIT>\s*<START_LINE>(\d+)<\/START_LINE>\s*<END_LINE>(\d+)<\/END_LINE>\s*<REPLACEMENT>\n?([\s\S]*?)\n?<\/REPLACEMENT>\s*<\/EDIT>/;

export function parseSuggestion(response: string, document: vscode.TextDocument): NextEditSuggestion | undefined {
	const trimmed = response.trim();
	if (!trimmed || trimmed === 'NONE') {
		return undefined;
	}

	const match = RESPONSE_PATTERN.exec(trimmed);
	if (!match) {
		return undefined;
	}

	const startLine = parseInt(match[1], 10) - 1;
	const endLine = parseInt(match[2], 10) - 1;
	if (Number.isNaN(startLine) || Number.isNaN(endLine) || startLine < 0 || endLine >= document.lineCount || startLine > endLine) {
		return undefined;
	}

	const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
	const original = document.getText(range);
	if (normalizeWhitespace(original) === normalizeWhitespace(match[3])) {
		// Not a meaningful edit (whitespace-only diff); treat like no suggestion.
		return undefined;
	}

	return { range, replacementText: normalizeLineEndings(match[3], document.eol) };
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// LLM output is plain LF; on a CRLF document every line would otherwise mismatch by its
// trailing \r alone, which breaks the line-up-based diff rendering far past the actual edit.
function normalizeLineEndings(text: string, eol: vscode.EndOfLine): string {
	const lf = text.replace(/\r\n/g, '\n');
	return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, '\r\n') : lf;
}
