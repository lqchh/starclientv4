export class Timer {
    constructor() {
        this.epoch = Date.now();
        this.pausedAt = 0;
        this.delayTarget = 0;
        this.running = false;
    }

    setDelay(delay) {
        this.epoch = Date.now();
        this.pausedAt = 0;
        this.delayTarget = delay;
        this.running = true;
    }

    setDelayRandom(min, max) {
        this.setDelay(Math.floor(Math.random() * (max - min + 1)) + min);
    }

    hasReachedDelay() {
        if (this.running) return this.hasPassed(this.delayTarget);
        else return false;
    }

    getTime() {
        return this.epoch;
    }

    setTime(newTime) {
        this.epoch = newTime;
    }

    hasPassed(duration) {
        return Date.now() - this.epoch >= duration;
    }

    getTimePassed() {
        const now = Date.now();
        if (this.pausedAt > 0) {
            return this.pausedAt - this.epoch;
        }
        return now - this.epoch;
    }

    pause() {
        if (this.pausedAt === 0) {
            this.pausedAt = Date.now();
        }
    }

    unpause() {
        if (this.pausedAt > 0) {
            const pauseDuration = Date.now() - this.pausedAt;
            this.epoch += pauseDuration;
            this.pausedAt = 0;
        }
    }

    reset() {
        this.epoch = Date.now();
        this.pausedAt = 0;
        this.running = false;
    }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const randomBetween = (min, max) => min + Math.random() * (max - min);
const randomInt = (min, max) => Math.floor(randomBetween(min, max + 1));

export class HumanizedCpsTimer {
    constructor(options = {}) {
        this.jitter = options.jitter ?? 0.16;
        this.intervalBias = options.intervalBias ?? 0.94;
        this.pauseEveryMin = options.pauseEveryMin ?? 9;
        this.pauseEveryMax = options.pauseEveryMax ?? 20;
        this.minPauseMs = options.minPauseMs ?? 45;
        this.maxPauseMs = options.maxPauseMs ?? 140;
        this.minIntervalScale = options.minIntervalScale ?? 0.72;
        this.maxIntervalScale = options.maxIntervalScale ?? 1.45;
        this.nextClickAt = 0;
        this.clicksUntilPause = this.nextBurstLength();
    }

    nextBurstLength() {
        return randomInt(this.pauseEveryMin, this.pauseEveryMax);
    }

    reset(ready = true) {
        this.nextClickAt = ready ? 0 : Date.now();
        this.clicksUntilPause = this.nextBurstLength();
    }

    getNextInterval(targetCps) {
        const cps = clamp(Number(targetCps) || 1, 1, 30);
        const baseInterval = 1000 / cps;
        const triangularJitter = (Math.random() + Math.random() - 1) * this.jitter;
        let interval = baseInterval * this.intervalBias * (1 + triangularJitter);

        this.clicksUntilPause--;
        if (this.clicksUntilPause <= 0) {
            interval += randomBetween(this.minPauseMs, this.maxPauseMs);
            this.clicksUntilPause = this.nextBurstLength();
        } else if (Math.random() < 0.025) {
            interval += randomBetween(20, 65);
        }

        return clamp(interval, baseInterval * this.minIntervalScale, baseInterval * this.maxIntervalScale + this.maxPauseMs);
    }

    canClick(now = Date.now()) {
        return now >= this.nextClickAt;
    }

    markClick(targetCps, now = Date.now()) {
        this.nextClickAt = now + this.getNextInterval(targetCps);
    }

    tryClick(targetCps, now = Date.now()) {
        if (!this.canClick(now)) return false;
        this.markClick(targetCps, now);
        return true;
    }
}

export class HumanizedDelayTimer {
    constructor(options = {}) {
        this.jitter = options.jitter ?? 0.14;
        this.pauseEveryMin = options.pauseEveryMin ?? 7;
        this.pauseEveryMax = options.pauseEveryMax ?? 16;
        this.minPauseMs = options.minPauseMs ?? 35;
        this.maxPauseMs = options.maxPauseMs ?? 130;
        this.minDelayScale = options.minDelayScale ?? 0.75;
        this.maxDelayScale = options.maxDelayScale ?? 1.4;
        this.nextActionAt = 0;
        this.actionsUntilPause = this.nextBurstLength();
    }

    nextBurstLength() {
        return randomInt(this.pauseEveryMin, this.pauseEveryMax);
    }

    reset(ready = true) {
        this.nextActionAt = ready ? 0 : Date.now();
        this.actionsUntilPause = this.nextBurstLength();
    }

    getNextDelay(targetDelayMs) {
        const baseDelay = Math.max(Number(targetDelayMs) || 0, 0);
        if (baseDelay <= 0) return 0;

        const triangularJitter = (Math.random() + Math.random() - 1) * this.jitter;
        let delay = baseDelay * (1 + triangularJitter);

        this.actionsUntilPause--;
        if (this.actionsUntilPause <= 0) {
            delay += randomBetween(this.minPauseMs, this.maxPauseMs);
            this.actionsUntilPause = this.nextBurstLength();
        } else if (Math.random() < 0.03) {
            delay += randomBetween(15, 55);
        }

        return clamp(delay, baseDelay * this.minDelayScale, baseDelay * this.maxDelayScale + this.maxPauseMs);
    }

    canAct(now = Date.now()) {
        return now >= this.nextActionAt;
    }

    markAction(targetDelayMs, now = Date.now()) {
        this.nextActionAt = now + this.getNextDelay(targetDelayMs);
    }

    tryAction(targetDelayMs, now = Date.now()) {
        if (!this.canAct(now)) return false;
        this.markAction(targetDelayMs, now);
        return true;
    }
}

export const TimeUtils = {
    /**
     * Formats a duration in ms into the good looking string
     * Examples: 0.00s, 12.34s, 1m 2s, 3h 4m 5s, 2d 3h 4m 5s
     */
    formatDurationMs: (durationMs) => {
        if (!durationMs || durationMs <= 0) return '0.00s';

        const totalSeconds = Math.floor(durationMs / 1000);

        const s = totalSeconds % 60;
        const m = Math.floor(totalSeconds / 60) % 60;
        const h = Math.floor(totalSeconds / 3600) % 24;
        const d = Math.floor(totalSeconds / 86400);

        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);

        if (totalSeconds < 60) {
            const cs = Math.floor((durationMs % 1000) / 10);
            const csStr = String(cs).padStart(2, '0');
            parts.push(`${s}.${csStr}s`);
        } else {
            parts.push(`${s}s`);
        }

        return parts.join(' ');
    },

    /**
     * Time since start timestamp
     */
    formatUptime: (startTimeMs) => {
        if (!startTimeMs) return '0.00s';
        return TimeUtils.formatDurationMs(Date.now() - startTimeMs);
    },
};
