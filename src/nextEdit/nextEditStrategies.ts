import * as vscode from 'vscode';
import { ChatMessage } from '../llm/types';
import { NextEditSuggestion, parseSuggestion } from './nextEditService';

export interface RecentEditContextLike {
	diff: string;
	changedLineRanges: Array<{ start: number; end: number }>;
}

export interface NextEditStrategyArgs {
	document: vscode.TextDocument;
	recentEdit?: RecentEditContextLike;
	options: {
		maxTokens: number;
		model?: string;
		thinkingBudget?: number;
		baseUrl?: string;
		apiKey?: string;
	};
}

export interface NextEditStrategyRequest {
	mode: 'chat' | 'infill';
	messages?: ChatMessage[];
	prefix?: string;
	suffix?: string;
	targetRange?: vscode.Range;
}

export interface NextEditStrategyDefinition {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	buildRequest: (args: NextEditStrategyArgs) => NextEditStrategyRequest;
	parse: (response: string, document: vscode.TextDocument, targetRange?: vscode.Range) => NextEditSuggestion | undefined;
}

export const NEXT_EDIT_STRATEGIES: Record<string, NextEditStrategyDefinition> = {
	clownfish: {
		id: 'clownfish',
		label: 'Clownfish',
		description: 'Current chat-based strict XML edit output.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => ({
			mode: 'chat',
			messages: [
				{ role: 'system', content: CLOWNFISH_SYSTEM_PROMPT },
				{ role: 'user', content: buildUserPrompt(document, recentEdit) },
			],
		}),
		parse: (response: string, document: vscode.TextDocument): NextEditSuggestion | undefined => parseSuggestion(response, document),
	},
	tang: {
		id: 'tang',
		label: 'Tang',
		description: 'Short chat prompt optimized for terse, single-edit JSON output.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => ({
			mode: 'chat',
			messages: [
				{ role: 'system', content: TANG_SYSTEM_PROMPT },
				{ role: 'user', content: buildUserPrompt(document, recentEdit) },
			],
		}),
		parse: (response: string, document: vscode.TextDocument): NextEditSuggestion | undefined => parseJsonLikeSuggestion(response, document) ?? parseSuggestion(response, document),
	},
	manta: {
		id: 'manta',
		label: 'Manta',
		description: 'Completion/FIM mode using the infill API with a targeted prefix/suffix replacement hole.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => {
			const { range, prefix, suffix } = buildFIMRange(document, recentEdit);
			return {
				mode: 'infill',
				targetRange: range,
				prefix,
				suffix,
			};
		},
		parse: (response: string, document: vscode.TextDocument, targetRange?: vscode.Range): NextEditSuggestion | undefined => parseFIMResponse(response, document, targetRange),
	},
	parrotfish: {
		id: 'parrotfish',
		label: 'Parrotfish',
		description: 'Llama/FIM format using <|fim_prefix|> / <|fim_suffix|> / <|fim_middle|>.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => {
			const { range, prefix, suffix } = buildFIMRange(document, recentEdit);
			return {
				mode: 'infill',
				targetRange: range,
				prefix: `${prefix}<|fim_prefix|>`,
				suffix: `<|fim_suffix|>${suffix}<|fim_middle|>`,
			};
		},
		parse: (response: string, document: vscode.TextDocument, targetRange?: vscode.Range): NextEditSuggestion | undefined => parseFIMResponse(response, document, targetRange),
	},
	butterflyfish: {
		id: 'butterflyfish',
		label: 'Butterflyfish',
		description: 'Extended FIM format using <|fim▁begin|> / <|fim▁hole|> / <|fim▁end|>.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => {
			const { range, prefix, suffix } = buildFIMRange(document, recentEdit);
			return {
				mode: 'infill',
				targetRange: range,
				prefix: `${prefix}<|fim▁begin|>`,
				suffix: `<|fim▁hole|>${suffix}<|fim▁end|>`,
			};
		},
		parse: (response: string, document: vscode.TextDocument, targetRange?: vscode.Range): NextEditSuggestion | undefined => parseFIMResponse(response, document, targetRange),
	},
	damselfish: {
		id: 'damselfish',
		label: 'Damselfish',
		description: 'Compact FIM instructions using <PRE> / <SUF> / <MID> tags.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => {
			const { range, prefix, suffix } = buildFIMRange(document, recentEdit);
			return {
				mode: 'infill',
				targetRange: range,
				prefix: `${prefix} <PRE> ${prefix}`,
				suffix: ` <SUF>${suffix} <MID>`,
			};
		},
		parse: (response: string, document: vscode.TextDocument, targetRange?: vscode.Range): NextEditSuggestion | undefined => parseFIMResponse(response, document, targetRange),
	},
	wrasse: {
		id: 'wrasse',
		label: 'Wrasse',
		description: 'Minimal JSON schema for models that respond better to compact structured output.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => ({
			mode: 'chat',
			messages: [
				{ role: 'system', content: WRASSE_SYSTEM_PROMPT },
				{ role: 'user', content: buildUserPrompt(document, recentEdit) },
			],
		}),
		parse: (response: string, document: vscode.TextDocument): NextEditSuggestion | undefined => parseJsonLikeSuggestion(response, document) ?? parseSuggestion(response, document),
	},
};

export type NextEditStrategyId = keyof typeof NEXT_EDIT_STRATEGIES;

export function resolveNextEditStrategy(id?: string): NextEditStrategyDefinition {
	const key = (id ?? 'clownfish') as string;
	return NEXT_EDIT_STRATEGIES[key] ?? NEXT_EDIT_STRATEGIES.clownfish;
}

function buildUserPrompt(document: vscode.TextDocument, recentEdit?: RecentEditContextLike): string {
	const numberedLines: string[] = [];
	for (let i = 0; i < document.lineCount; i++) {
		numberedLines.push(`${i + 1}: ${document.lineAt(i).text}`);
	}
	const editPrompt = recentEdit
		? `The developer's recent changes are:\n${recentEdit.diff}`
		: 'There is no recent automatic edit diff; infer useful consistency changes from the current file.';
	return `File:\n${numberedLines.join('\n')}\n\n${editPrompt}`;
}

function buildFIMRange(document: vscode.TextDocument, recentEdit?: RecentEditContextLike): { range: vscode.Range; prefix: string; suffix: string } {
	const changedRange = recentEdit?.changedLineRanges?.[0];
	const preferredStart = changedRange ? changedRange.start : Math.max(0, Math.floor(document.lineCount / 2) - 1);
	const preferredEnd = changedRange ? changedRange.end : Math.min(document.lineCount - 1, preferredStart + 1);
	const startLine = Math.max(0, Math.min(preferredStart, document.lineCount - 1));
	const endLine = Math.max(startLine, Math.min(preferredEnd, document.lineCount - 1));
	const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
	const fullText = document.getText();
	const prefix = fullText.slice(0, document.offsetAt(new vscode.Position(startLine, 0)));
	const suffix = fullText.slice(document.offsetAt(new vscode.Position(endLine, document.lineAt(endLine).text.length)));
	return { range, prefix, suffix };
}

function parseJsonLikeSuggestion(response: string, document: vscode.TextDocument): NextEditSuggestion | undefined {
	const trimmed = response.trim();
	if (!trimmed || trimmed === 'NONE') {
		return undefined;
	}

	try {
		const parsed = JSON.parse(trimmed);
		const startLine = Number(parsed.startLine ?? parsed.start_line ?? parsed.lineStart ?? 1);
		const endLine = Number(parsed.endLine ?? parsed.end_line ?? parsed.lineEnd ?? startLine);
		const replacementText = typeof parsed.replacement === 'string' ? parsed.replacement : (typeof parsed.text === 'string' ? parsed.text : '');
		if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || !replacementText) {
			return undefined;
		}
		const normalizedStart = Math.max(0, startLine - 1);
		const normalizedEnd = Math.min(document.lineCount - 1, Math.max(normalizedStart, endLine - 1));
		const range = new vscode.Range(normalizedStart, 0, normalizedEnd, document.lineAt(normalizedEnd).text.length);
		const original = document.getText(range);
		if (normalizeWhitespace(original) === normalizeWhitespace(replacementText)) {
			return undefined;
		}
		return { range, replacementText: normalizeLineEndings(replacementText, document.eol) };
	} catch {
		return undefined;
	}
}

function parseFIMResponse(response: string, document: vscode.TextDocument, targetRange?: vscode.Range): NextEditSuggestion | undefined {
	const cleaned = stripFIMMarkers(response);
	if (!cleaned || cleaned === 'NONE') {
		return undefined;
	}
	const range = targetRange ?? new vscode.Range(0, 0, Math.min(document.lineCount - 1, 0), document.lineAt(0).text.length);
	const replacementText = normalizeLineEndings(cleaned, document.eol);
	const original = document.getText(range);
	if (normalizeWhitespace(original) === normalizeWhitespace(replacementText)) {
		return undefined;
	}
	return { range, replacementText };
}

function stripFIMMarkers(value: string): string {
	let cleaned = value.replace(/<\|fim[_\s]?(prefix|suffix|middle|begin|hole|end)\|>/gi, '');
	cleaned = cleaned.replace(/<PRE>|<SUF>|<MID>/gi, '');
	cleaned = cleaned.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '');
	return cleaned;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function normalizeLineEndings(text: string, eol: vscode.EndOfLine): string {
	const lf = text.replace(/\r\n/g, '\n');
	return eol === vscode.EndOfLine.CRLF ? lf.replace(/\n/g, '\r\n') : lf;
}

const CLOWNFISH_SYSTEM_PROMPT = 'You are a code editing assistant. Given a file (with 1-based line numbers) and a '
	+ 'diff showing the developer\'s recent changes, propose exactly one small follow-up edit elsewhere in the file that '
	+ 'keeps the code consistent (e.g. a matching usage, an import, or a related declaration). '
	+ 'Respond using EXACTLY this format and nothing else, with no markdown fences:\n'
	+ '<EDIT><START_LINE>n</START_LINE><END_LINE>n</END_LINE><REPLACEMENT>\ncode\n</REPLACEMENT></EDIT>\n'
	+ 'START_LINE and END_LINE are 1-based and inclusive, referring to the numbered lines shown to you. '
	+ 'REPLACEMENT is the full text that should replace those lines. '
	+ 'If no follow-up edit is needed, respond with exactly: NONE';

const TANG_SYSTEM_PROMPT = 'Return exactly one small code edit in JSON. Use this schema and nothing else: {"startLine": 12, "endLine": 12, "replacement": "code"}. If no edit is needed, return "NONE".';
const WRASSE_SYSTEM_PROMPT = 'Return only a minimal JSON object with startLine, endLine, and replacement for the exact edit to make. Do not include prose. If no edit is needed, return "NONE".';
