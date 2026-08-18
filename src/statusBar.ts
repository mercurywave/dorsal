import * as vscode from 'vscode';
import { LlmService, Workflow } from './llm/llmService';

interface DorsalMenuItem extends vscode.QuickPickItem {
	action: () => void | Thenable<void>;
}

export class DorsalStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly subscription: vscode.Disposable;
	private readonly erroredWorkflows = new Set<Workflow>();

	constructor(private readonly llmService: LlmService, private readonly outputChannel: vscode.OutputChannel) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'dorsal.showMenu';
		this.item.show();
		this.subscription = this.llmService.onDidChangeWorkflowStatus(({ workflow, status }) => {
			if (status === 'error') {
				this.erroredWorkflows.add(workflow);
			} else {
				this.erroredWorkflows.delete(workflow);
			}
			this.refresh();
		});
		this.refresh();
	}

	refresh(): void {
		const hasError = this.erroredWorkflows.size > 0;
		this.item.text = hasError ? '$(fish4-happy) $(error)' : '$(fish4-happy)';
		this.item.backgroundColor = hasError ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
		this.item.tooltip = hasError
			? `Dorsal AI assistant - recent error in: ${[...this.erroredWorkflows].join(', ')}`
			: 'Dorsal AI assistant - click to configure';
	}

	// Called when the user changes any dorsal.* setting, since a reconfigured provider deserves a clean slate.
	resetErrors(): void {
		this.erroredWorkflows.clear();
		this.refresh();
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
		const completionTriggerMode = cfg.get<'automatic' | 'manual' | 'off'>('completions.triggerMode', 'automatic');
		const completionLabel = completionTriggerMode === 'automatic' ? 'Auto'
			: completionTriggerMode === 'manual' ? 'Manual' : 'Off';
		const completionIcon = completionTriggerMode === 'automatic' ? 'zap'
			: completionTriggerMode === 'manual' ? 'debug-pause' : 'circle-slash';
		const nextCompletionTriggerMode = completionTriggerMode === 'automatic' ? 'manual' : 'automatic';
		const autoTriggerEnabled = cfg.get<boolean>('nextEditSuggestions.autoTrigger', true);
		const nextEditIcon = autoTriggerEnabled ? 'zap' : 'debug-pause';

		return [
			{
				label: '$(gear) Settings',
				description: 'Open Dorsal settings',
				action: () => vscode.commands.executeCommand('workbench.action.openSettings', 'dorsal.'),
			},
			{
				label: `$(${completionIcon}) Completions: ${completionLabel}`,
				description: `Switch to ${nextCompletionTriggerMode} inline completions`,
				action: () => this.updateSetting('completions.triggerMode', nextCompletionTriggerMode),
			},
			{
				label: `$(${nextEditIcon}) Next Edits: ${autoTriggerEnabled ? 'Auto' : 'Manual'}`,
				description: `Switch to ${autoTriggerEnabled ? 'manual' : 'automatic'} next-edit suggestions`,
				action: () => this.updateSetting('nextEditSuggestions.autoTrigger', !autoTriggerEnabled),
			},
			{
				label: '$(output) Show Logs',
				description: 'Open the Dorsal output channel',
				action: () => this.outputChannel.show(),
			},
		];
	}

	private async updateSetting(key: string, value: boolean | 'automatic' | 'manual'): Promise<void> {
		await vscode.workspace.getConfiguration('dorsal').update(key, value, vscode.ConfigurationTarget.Global);
	}

	dispose(): void {
		this.subscription.dispose();
		this.item.dispose();
	}
}

