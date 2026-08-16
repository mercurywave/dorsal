import * as vscode from 'vscode';
import { LlmService } from '../llm/llmService';

export interface NextEditSuggestion {
	range: vscode.Range;
	replacementText: string;
}

// Requires a strict, machine-parseable response since model verbosity would otherwise
// be unreliable to parse into a concrete text edit.
const SYSTEM_PROMPT = 'You are a code editing assistant. Given a file (with 1-based line numbers) and the '
	+ 'line the developer just changed, propose exactly one small follow-up edit elsewhere in the file that '
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

	async suggest(document: vscode.TextDocument, changedLine: number, maxTokens: number, model: string): Promise<NextEditSuggestion | undefined> {
		const numberedLines: string[] = [];
		for (let i = 0; i < document.lineCount; i++) {
			numberedLines.push(`${i + 1}: ${document.lineAt(i).text}`);
		}
		const userPrompt = `File:\n${numberedLines.join('\n')}\n\nThe developer just changed line ${changedLine + 1}.`;

		let response: string;
		try {
			response = await this.llmService.chat(
				[
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: userPrompt },
				],
				{ maxTokens, model },
			);
		} catch (err) {
			this.log(`next edit suggestion request failed: ${String(err)}`);
			return undefined;
		}

		return parseSuggestion(response, document);
	}
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

	return { range, replacementText: match[3] };
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
