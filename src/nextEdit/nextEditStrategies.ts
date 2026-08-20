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
	mode: 'chat' | 'completions';
	messages?: ChatMessage[];
	prompt?: string;
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
	+ 'Do not target the lines in the developer\'s recent diff itself; those were just edited and are not valid follow-up targets. '
	+ 'Respond using EXACTLY this XML format and nothing else, with no markdown fences:\n'
	+ '<EDIT><START_LINE>n</START_LINE><END_LINE>n</END_LINE><REPLACEMENT>code</REPLACEMENT></EDIT>\n'
	+ 'START_LINE and END_LINE are 1-based and inclusive, referring to the numbered lines shown to you. '
	+ 'Code inside REPLACEMENT is the full text that should replace those lines. '
	+ 'If no follow-up edit is needed, respond with exactly: NONE';

const TANG_SYSTEM_PROMPT = 'Return exactly one precise follow-up edit in JSON using the numbered file in the user prompt as the source of truth. '
	+ 'Choose a target range outside the recent diff lines. Use this schema and nothing else: '
	+ '{"startLine": 12, "endLine": 12, "replacement": "  return getUserDisplayName(user);"}. '
	+ 'The replacement must be the COMPLETE final text for the entire affected line(s), not a partial token, symbol, or fragment. '
	+ 'Include the full indentation and all code text for the target line(s). '
	+ 'If no edit is needed, return "NONE".';

const WRASSE_SYSTEM_PROMPT = 'Return only one minimal JSON object with startLine, endLine, and replacement for the exact edit to make. '
	+ 'Use the numbered file contents as the source of truth; do not target the recent diff lines. '
	+ 'The replacement must be the COMPLETE final text for the full target line(s), not a token, symbol, or partial fragment. '
	+ 'Include the full indentation and all code for every affected line. '
	+ 'Example: {"startLine": 8, "endLine": 8, "replacement": "  const displayName = getDisplayName(user);"}. '
	+ 'If no edit is needed, return "NONE".';
