export interface InfillOptions {
	maxTokens: number;
	model?: string;
	stop?: string[];
	temperature?: number;
	baseUrl?: string;
	apiKey?: string;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	maxTokens: number;
	model?: string;
	stop?: string[];
	temperature?: number;
	// Caps reasoning/thinking tokens for models that support extended thinking.
	thinkingBudget?: number;
	baseUrl?: string;
	apiKey?: string;
}

export interface LlmProvider {
	readonly name: string;
	infill(prefix: string, suffix: string, options: InfillOptions): Promise<string>;
	chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
	checkHealth(): Promise<boolean>;
}
