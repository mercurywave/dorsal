import * as vscode from 'vscode';
import { LlmService } from './llm/llmService';

export class DorsalStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor(private readonly llmService: LlmService) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = { command: 'workbench.action.openSettings', arguments: ['dorsal.'], title: 'Configure Dorsal' };
		this.item.show();
		this.refresh();
	}

	refresh(): void {
		this.item.text = '$(fish4-happy)';
		this.item.tooltip = 'Dorsal AI assistant - click to configure';
	}

	dispose(): void {
		this.item.dispose();
	}
}
