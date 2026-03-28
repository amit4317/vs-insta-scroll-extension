/**
 * focusMode.ts
 *
 * Distraction-free viewing mode that hides VS Code interface elements.
 * Features:
 *   - Hide activity bar
 *   - Hide status bar  
 *   - Hide panel
 *   - Maximize sidebar width
 *   - Zen mode integration
 */

import * as vscode from 'vscode';

export class FocusMode {
  private isActive: boolean = false;
  private previousState: {
    activityBarVisible: boolean;
    statusBarVisible: boolean;
    panelVisible: boolean;
    sidebarWidth: number;
  } | null = null;

  async toggle(): Promise<boolean> {
    if (this.isActive) {
      await this.disable();
      return false;
    } else {
      await this.enable();
      return true;
    }
  }

  private async enable(): Promise<void> {
    if (this.isActive) return;

    // Store current state
    const config = vscode.workspace.getConfiguration('workbench');
    this.previousState = {
      activityBarVisible: config.get('activityBar.visible', true),
      statusBarVisible: config.get('statusBar.visible', true),
      panelVisible: false, // Will check dynamically
      sidebarWidth: 0, // Could measure current width
    };

    // Hide UI elements
    await vscode.workspace.getConfiguration().update('workbench.activityBar.visible', false, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update('workbench.statusBar.visible', false, vscode.ConfigurationTarget.Global);
    
    // Close panel if open
    await vscode.commands.executeCommand('workbench.action.closePanel');
    
    // Maximize sidebar by setting layout
    await vscode.commands.executeCommand('workbench.action.maximizeSidebar');

    this.isActive = true;
    
    void vscode.window.showInformationMessage('🎯 Focus Mode enabled. Press Esc or toggle again to exit.');
  }

  async disable(): Promise<void> {
    if (!this.isActive || !this.previousState) return;

    // Restore UI elements
    await vscode.workspace.getConfiguration().update('workbench.activityBar.visible', this.previousState.activityBarVisible, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update('workbench.statusBar.visible', this.previousState.statusBarVisible, vscode.ConfigurationTarget.Global);

    // Restore sidebar width (could be improved with actual measurement)
    await vscode.commands.executeCommand('workbench.action.resetSidebarWidth');

    this.isActive = false;
    this.previousState = null;
    
    void vscode.window.showInformationMessage('Focus Mode disabled.');
  }

  getStatus(): boolean {
    return this.isActive;
  }

  dispose(): void {
    if (this.isActive) {
      void this.disable();
    }
  }
}
