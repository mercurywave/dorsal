import * as vscode from 'vscode';
import { readConfig } from '../config';
import { LlmService } from '../llm/llmService';

// Keep prompt context bounded so requests stay fast against local llama.cpp servers.
const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 2000;

const CHAT_SYSTEM_PROMPT = 'You are an inline code-completion assistant. Reply with ONLY the text to insert at the cursor, '
	+ 'with no explanation or markdown. Do not repeat text after the cursor.';

export class DorsalInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private pendingTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly llmService: LlmService,
		private readonly log: (message: string) => void,
	) {}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionList | undefined> {
		const config = readConfig();
		if (config.completions.triggerMode === 'off'
			|| (config.completions.triggerMode === 'manual' && context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke)) {
			return undefined;
		}

		const debounced = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
			|| await this.debounce(config.completions.debounceMs, token);
		if (!debounced || token.isCancellationRequested) {
			return undefined;
		}

		const prefix = document.getText(new vscode.Range(document.positionAt(0), position)).slice(-MAX_PREFIX_CHARS);
		const suffixEnd = document.positionAt(document.getText().length);
		const suffix = document.getText(new vscode.Range(position, suffixEnd)).slice(0, MAX_SUFFIX_CHARS);

		let completion: string;
		try {
			completion = config.completions.useInfillApi
				? await this.llmService.infill(prefix, suffix, {
					maxTokens: config.completions.maxTokens,
					model: config.completions.model,
					stop: ['\n\n'],
					baseUrl: config.completions.baseUrl,
					apiKey: config.completions.apiKey,
				}, 'completions')
				: await this.llmService.chat(
					[
						{ role: 'system', content: CHAT_SYSTEM_PROMPT },
						{ role: 'user', content: `Code before cursor:\n${prefix}\n\nCode after cursor:\n${suffix}\n\nText to insert:` },
					],
					{ maxTokens: config.completions.maxTokens, model: config.completions.model, stop: ['\n\n'], baseUrl: config.completions.baseUrl, apiKey: config.completions.apiKey },
					'completions',
				);
		} catch (err) {
			this.log(`inline completion request failed: ${String(err)}`);
			return undefined;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		const trimmed = trimOverlapWithSuffix(completion, suffix);
		if (!trimmed) {
			return undefined;
		}

		const truncated = truncateToLines(trimmed, config.completions.maxLines);
		if (!truncated) {
			return undefined;
		}
		const item = new vscode.InlineCompletionItem(truncated, new vscode.Range(position, position));
		return new vscode.InlineCompletionList([item]);
	}

	// Waits out the configured debounce, resolving false early if cancelled.
	private debounce(ms: number, token: vscode.CancellationToken): Promise<boolean> {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
		}
		return new Promise((resolve) => {
			const cancelListener = token.onCancellationRequested(() => {
				clearTimeout(this.pendingTimer);
				resolve(false);
			});
			this.pendingTimer = setTimeout(() => {
				cancelListener.dispose();
				resolve(true);
			}, ms);
		});
	}
}

// Avoids duplicating text the model already sees as suffix (e.g. a closing brace it echoed back).
function trimOverlapWithSuffix(completion: string, suffix: string): string {
	if (!completion) {
		return completion;
	}
	const maxOverlap = Math.min(completion.length, suffix.length);
	for (let len = maxOverlap; len > 0; len--) {
		if (completion.endsWith(suffix.slice(0, len))) {
			return completion.slice(0, completion.length - len);
		}
	}
	return completion;
}

function truncateToLines(text: string, maxLines: number): string {
	const lines = text.split('\n');
	if (lines.length <= maxLines) {
		return text;
	}
	return lines.slice(0, maxLines).join('\n');
}
