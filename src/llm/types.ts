export interface InfillOptions {
	maxTokens: number;
	stop?: string[];
	temperature?: number;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	maxTokens: number;
	temperature?: number;
}

export interface LlmProvider {
	readonly name: string;
	infill(prefix: string, suffix: string, options: InfillOptions): Promise<string>;
	chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
	checkHealth(): Promise<boolean>;
}
