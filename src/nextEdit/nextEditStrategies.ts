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
		description: 'Git-style diff hunk for minimal patch output from models that do better with patch syntax.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => ({
			mode: 'chat',
			messages: [
				{ role: 'system', content: WRASSE_SYSTEM_PROMPT },
				{ role: 'user', content: buildUserPrompt(document, recentEdit) },
			],
		}),
		parse: (response: string, document: vscode.TextDocument): NextEditSuggestion | undefined => parseGitDiffSuggestion(response, document) ?? parseJsonLikeSuggestion(response, document) ?? parseSuggestion(response, document),
	},
	manta: {
		id: 'manta',
		label: 'Manta',
		description: 'Completion-style diff continuation for models that prefer to fill a patch hunk after a seeded prompt.',
		buildRequest: ({ document, recentEdit }: NextEditStrategyArgs): NextEditStrategyRequest => ({
			mode: 'completions',
			prompt: buildCompletionPrompt(document, recentEdit),
		}),
		parse: (response: string, document: vscode.TextDocument): NextEditSuggestion | undefined => parseGitDiffSuggestion(response, document) ?? parseJsonLikeSuggestion(response, document) ?? parseSuggestion(response, document),
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

function buildCompletionPrompt(document: vscode.TextDocument, recentEdit?: RecentEditContextLike): string {
	const numberedLines: string[] = [];
	for (let i = 0; i < document.lineCount; i++) {
		numberedLines.push(`${i + 1}: ${document.lineAt(i).text}`);
	}
	const previousDiff = recentEdit
		? recentEdit.diff
		: 'There is no recent automatic edit diff; infer a useful consistency edit from the file.';
	return [
		MANTA_COMPLETION_PROMPT,
		'',
		'File:',
		numberedLines.join('\n'),
		'',
		'previous diff:',
		previousDiff,
		'',
		'next diff:',
	].join('\n');
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

function parseGitDiffSuggestion(response: string, document: vscode.TextDocument): NextEditSuggestion | undefined {
	const trimmed = response.trim();
	if (!trimmed || trimmed === 'NONE') {
		return undefined;
	}

	const hunkMatch = /^@@ -(?<oldStart>\d+)(?:,(?<oldLength>\d+))? \+(?<newStart>\d+)(?:,(?<newLength>\d+))? @@\r?\n(?<body>[\s\S]*)$/m.exec(trimmed);
	if (!hunkMatch?.groups) {
		return undefined;
	}

	const oldStart = Number(hunkMatch.groups.oldStart);
	const oldLength = Number(hunkMatch.groups.oldLength ?? '1');
	const bodyLines = hunkMatch.groups.body.split(/\r?\n/);
	const replacementLines: string[] = [];
	const oldLines: string[] = [];
	for (const line of bodyLines) {
		if (!line || line.startsWith('\\')) {
			continue;
		}
		if (line.startsWith('-')) {
			oldLines.push(line.slice(1));
			continue;
		}
		if (line.startsWith('+')) {
			replacementLines.push(line.slice(1));
			continue;
		}
		if (line.startsWith(' ')) {
			oldLines.push(line.slice(1));
			replacementLines.push(line.slice(1));
		}
	}
	if (replacementLines.length === 0) {
		return undefined;
	}

	const oldText = oldLines.join(document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
	const replacementText = replacementLines.join(document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
	if (normalizeWhitespace(oldText) === normalizeWhitespace(replacementText)) {
		return undefined;
	}

	const normalizedStart = Math.max(0, oldStart - 1);
	const rangeLength = Math.max(1, oldLength || 1);
	const normalizedEnd = Math.min(document.lineCount - 1, normalizedStart + rangeLength - 1);
	const range = new vscode.Range(normalizedStart, 0, normalizedEnd, document.lineAt(normalizedEnd).text.length);
	return { range, replacementText: normalizeLineEndings(replacementText, document.eol) };
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

const WRASSE_SYSTEM_PROMPT = 'Return exactly one git-style diff hunk for the single follow-up edit to make. '
	+ 'Use the numbered file contents as the source of truth; do not target the recent diff lines. '
	+ 'Output only the hunk body in unified diff format, like: "@@ -12,1 +12,1 @@\\n-const oldName = value;\\n+const newName = value;". '
	+ 'The new lines must be the COMPLETE final text for the full affected line(s), not a token or partial fragment. '
	+ 'Include the full indentation and every code line in the replacement. '
	+ 'If no edit is needed, return "NONE".';

const MANTA_COMPLETION_PROMPT = 'You are a code editing assistant. Review the numbered file and ignore the lines in the previous diff. '
	+ 'Your job is to write exactly one follow-up edit as a git-style diff hunk. '
	+ 'The hunk must start with an @@ header and include both removed and added lines. '
	+ 'Use the file as the source of truth and do not target the lines from the previous diff. '
	+ 'Return only the next diff, with no markdown fences, commentary, or explanation.\n\n';
