class Executor {
    constructor() {
        this.tickCallbacks = [];
        this.stepCallbacks = [];

        this.tickRegister = null;
        this.stepRegister = null;

        this.STEP_REGISTER_FPS = 240;
        this.STEP_FPS = 120;
        this.STEP_INTERVAL_MS = 1000 / this.STEP_FPS;
        this.STEP_TIMING_JITTER_MS = 2.75;
        this.nextStepDispatchAt = 0;
        this.lastStepDispatchAt = 0;
        this.stepDeltaMs = this.STEP_INTERVAL_MS;
    }

    execute() {
        this.destroy();

        this.tickRegister = register('tick', () => {
            for (let i = 0; i < this.tickCallbacks.length; i++) {
                const callback = this.tickCallbacks[i];
                if (typeof callback !== 'function') continue;
                try {
                    callback();
                } catch (e) {
                    console.error('PathExecutor tick callback error:', e);
                }
            }
        });

        this.nextStepDispatchAt = 0;
        this.lastStepDispatchAt = 0;
        this.stepDeltaMs = this.STEP_INTERVAL_MS;

        this.stepRegister = register('step', () => {
            const now = Date.now();
            if (this.nextStepDispatchAt > 0 && now < this.nextStepDispatchAt) return;

            this.stepDeltaMs = this.lastStepDispatchAt > 0 ? Math.max(1, Math.min(50, now - this.lastStepDispatchAt)) : this.STEP_INTERVAL_MS;
            this.lastStepDispatchAt = now;
            this.nextStepDispatchAt = now + this.STEP_INTERVAL_MS + this.randomTimingJitter();

            for (let i = 0; i < this.stepCallbacks.length; i++) {
                const callback = this.stepCallbacks[i];
                if (typeof callback !== 'function') continue;
                try {
                    callback();
                } catch (e) {
                    console.error('PathExecutor step callback error:', e);
                }
            }
        }).setFps(this.STEP_REGISTER_FPS);
    }

    destroy() {
        if (this.tickRegister) this.tickRegister.unregister();
        if (this.stepRegister) this.stepRegister.unregister();
        this.tickRegister = null;
        this.stepRegister = null;
        this.nextStepDispatchAt = 0;
        this.lastStepDispatchAt = 0;
        this.stepDeltaMs = this.STEP_INTERVAL_MS;
    }

    onTick(callback) {
        if (typeof callback === 'function') {
            this.tickCallbacks.push(callback);
        }
    }

    onStep(callback) {
        if (typeof callback === 'function') {
            this.stepCallbacks.push(callback);
        }
    }

    randomTimingJitter() {
        return (Math.random() * 2 - 1) * this.STEP_TIMING_JITTER_MS;
    }

    getStepDeltaSeconds() {
        return Math.max(0.001, Math.min(0.05, this.stepDeltaMs / 1000));
    }
}

export const PathExecutor = new Executor();
