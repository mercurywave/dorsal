import * as vscode from 'vscode';
import { LlmService } from './llm/llmService';

interface DorsalMenuItem extends vscode.QuickPickItem {
	action: () => void | Thenable<void>;
}

export class DorsalStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor(private readonly llmService: LlmService) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'dorsal.showMenu';
		this.item.show();
		this.refresh();
	}

	refresh(): void {
		this.item.text = '$(fish4-happy)';
		this.item.tooltip = 'Dorsal AI assistant - click to configure';
	}

	async showMenu(): Promise<void> {
		const qp = vscode.window.createQuickPick<DorsalMenuItem>();
		qp.title = 'Dorsal AI Assistant';
		qp.placeholder = 'Checking llama.cpp server…';
		qp.busy = true;
		qp.items = this.buildMenuItems();
		qp.onDidAccept(() => {
			const selected = qp.selectedItems[0];
			qp.hide();
			void selected?.action();
		});
		qp.onDidHide(() => qp.dispose());
		qp.show();

		const healthy = await this.llmService.checkHealth();
		qp.busy = false;
		qp.placeholder = healthy ? 'llama.cpp server is reachable' : 'llama.cpp server is unreachable';
	}

	private buildMenuItems(): DorsalMenuItem[] {
		const cfg = vscode.workspace.getConfiguration('dorsal');
		const completionsEnabled = cfg.get<boolean>('completions.enabled', true);
		const autoTriggerEnabled = cfg.get<boolean>('nextEditSuggestions.autoTrigger', true);

		return [
			{
				label: '$(gear) Settings',
				description: 'Open Dorsal settings',
				action: () => vscode.commands.executeCommand('workbench.action.openSettings', 'dorsal.'),
			},
			{
				label: `$(${completionsEnabled ? 'check' : 'circle-slash'}) Completions: ${completionsEnabled ? 'On' : 'Off'}`,
				description: 'Toggle inline tab completions',
				action: () => this.toggleSetting('completions.enabled', completionsEnabled),
			},
			{
				label: `$(${autoTriggerEnabled ? 'check' : 'circle-slash'}) Auto-Trigger Next Edit: ${autoTriggerEnabled ? 'On' : 'Off'}`,
				description: 'Toggle automatic next-edit suggestions',
				action: () => this.toggleSetting('nextEditSuggestions.autoTrigger', autoTriggerEnabled),
			},
		];
	}

	private async toggleSetting(key: string, currentValue: boolean): Promise<void> {
		await vscode.workspace.getConfiguration('dorsal').update(key, !currentValue, vscode.ConfigurationTarget.Global);
	}

	dispose(): void {
		this.item.dispose();
	}
}

