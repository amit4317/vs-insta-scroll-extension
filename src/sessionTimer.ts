/**
 * sessionTimer.ts
 *
 * Tracks user watch time and provides session statistics.
 * Features:
 *   - Session duration tracking
 *   - Daily goal monitoring
 *   - Break reminders
 *   - Achievement badges
 */

import * as vscode from 'vscode';

export interface SessionStats {
  sessionId: string;
  startTime: number;
  totalSeconds: number;
  reelsWatched: number;
  dailyGoalSeconds: number;
  breakReminderMinutes: number;
}

export class SessionTimer {
  private sessionId: string;
  private startTime: number;
  private totalSeconds: number = 0;
  private reelsWatched: number = 0;
  private dailyGoalSeconds: number = 30 * 60; // 30 minutes default
  private breakReminderMinutes: number = 20;
  private timerInterval: NodeJS.Timeout | undefined;
  private breakReminderInterval: NodeJS.Timeout | undefined;
  private lastBreakTime: number = 0;
  private onReelChangeCallback?: ((count: number) => void) | undefined;
  
  constructor(
    dailyGoalMinutes: number = 30,
    breakReminderMinutes: number = 20
  ) {
    this.sessionId = this.generateSessionId();
    this.startTime = Date.now();
    this.dailyGoalSeconds = dailyGoalMinutes * 60;
    this.breakReminderMinutes = breakReminderMinutes;
    this.lastBreakTime = Date.now();
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  start(): void {
    this.startTime = Date.now();
    this.totalSeconds = 0;
    this.reelsWatched = 0;
    this.lastBreakTime = Date.now();

    // Update counter every second
    this.timerInterval = setInterval(() => {
      this.totalSeconds++;
      this.checkDailyGoal();
    }, 1000);

    // Check for break reminder
    this.breakReminderInterval = setInterval(() => {
      this.checkBreakReminder();
    }, 60000); // Check every minute
  }

  stop(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
    if (this.breakReminderInterval) {
      clearInterval(this.breakReminderInterval);
      this.breakReminderInterval = undefined;
    }
  }

  incrementReelsWatched(): void {
    this.reelsWatched++;
    if (this.onReelChangeCallback) {
      this.onReelChangeCallback(this.reelsWatched);
    }
  }

  setOnReelChange(callback: (count: number) => void): void {
    this.onReelChangeCallback = callback;
  }

  private checkDailyGoal(): void {
    if (this.totalSeconds >= this.dailyGoalSeconds && this.totalSeconds < this.dailyGoalSeconds + 1) {
      void vscode.window.showInformationMessage(
        `🎯 Daily Goal Reached! You've watched ${this.formatTime(this.totalSeconds)} today.`,
        'Continue', 'Stop'
      ).then(selection => {
        if (selection === 'Stop') {
          void vscode.commands.executeCommand('vsInstaReels.close');
        }
      });
    }
  }

  private checkBreakReminder(): void {
    const sinceLastBreak = (Date.now() - this.lastBreakTime) / 1000 / 60;
    if (sinceLastBreak >= this.breakReminderMinutes) {
      void vscode.window.showInformationMessage(
        `⏰ Time for a break! You've been watching for ${this.breakReminderMinutes} minutes.`,
        'Take Break', 'Continue'
      ).then(selection => {
        if (selection === 'Take Break') {
          this.lastBreakTime = Date.now();
        }
      });
    }
  }

  getStats(): SessionStats {
    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      totalSeconds: this.totalSeconds,
      reelsWatched: this.reelsWatched,
      dailyGoalSeconds: this.dailyGoalSeconds,
      breakReminderMinutes: this.breakReminderMinutes,
    };
  }

  formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    
    if (h > 0) {
      return `${h}h ${m}m ${s}s`;
    } else if (m > 0) {
      return `${m}m ${s}s`;
    } else {
      return `${s}s`;
    }
  }

  getSessionDuration(): string {
    return this.formatTime(this.totalSeconds);
  }

  getProgressPercentage(): number {
    return Math.min(100, (this.totalSeconds / this.dailyGoalSeconds) * 100);
  }

  dispose(): void {
    this.stop();
  }
}
