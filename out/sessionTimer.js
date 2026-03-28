"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionTimer = void 0;
const vscode = require("vscode");
class SessionTimer {
    constructor(dailyGoalMinutes = 30, breakReminderMinutes = 20) {
        this.totalSeconds = 0;
        this.reelsWatched = 0;
        this.dailyGoalSeconds = 30 * 60; // 30 minutes default
        this.breakReminderMinutes = 20;
        this.lastBreakTime = 0;
        this.sessionId = this.generateSessionId();
        this.startTime = Date.now();
        this.dailyGoalSeconds = dailyGoalMinutes * 60;
        this.breakReminderMinutes = breakReminderMinutes;
        this.lastBreakTime = Date.now();
    }
    generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    start() {
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
    stop() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = undefined;
        }
        if (this.breakReminderInterval) {
            clearInterval(this.breakReminderInterval);
            this.breakReminderInterval = undefined;
        }
    }
    incrementReelsWatched() {
        this.reelsWatched++;
        if (this.onReelChangeCallback) {
            this.onReelChangeCallback(this.reelsWatched);
        }
    }
    setOnReelChange(callback) {
        this.onReelChangeCallback = callback;
    }
    checkDailyGoal() {
        if (this.totalSeconds >= this.dailyGoalSeconds && this.totalSeconds < this.dailyGoalSeconds + 1) {
            void vscode.window.showInformationMessage(`🎯 Daily Goal Reached! You've watched ${this.formatTime(this.totalSeconds)} today.`, 'Continue', 'Stop').then(selection => {
                if (selection === 'Stop') {
                    void vscode.commands.executeCommand('vsInstaReels.close');
                }
            });
        }
    }
    checkBreakReminder() {
        const sinceLastBreak = (Date.now() - this.lastBreakTime) / 1000 / 60;
        if (sinceLastBreak >= this.breakReminderMinutes) {
            void vscode.window.showInformationMessage(`⏰ Time for a break! You've been watching for ${this.breakReminderMinutes} minutes.`, 'Take Break', 'Continue').then(selection => {
                if (selection === 'Take Break') {
                    this.lastBreakTime = Date.now();
                }
            });
        }
    }
    getStats() {
        return {
            sessionId: this.sessionId,
            startTime: this.startTime,
            totalSeconds: this.totalSeconds,
            reelsWatched: this.reelsWatched,
            dailyGoalSeconds: this.dailyGoalSeconds,
            breakReminderMinutes: this.breakReminderMinutes,
        };
    }
    formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) {
            return `${h}h ${m}m ${s}s`;
        }
        else if (m > 0) {
            return `${m}m ${s}s`;
        }
        else {
            return `${s}s`;
        }
    }
    getSessionDuration() {
        return this.formatTime(this.totalSeconds);
    }
    getProgressPercentage() {
        return Math.min(100, (this.totalSeconds / this.dailyGoalSeconds) * 100);
    }
    dispose() {
        this.stop();
    }
}
exports.SessionTimer = SessionTimer;
//# sourceMappingURL=sessionTimer.js.map