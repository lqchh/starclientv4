import { Chat } from '../Chat';
import { MCHand, PathManager, Vec3d } from '../Constants';
import { CommonPingS2C, PlayerInteractItemC2S } from '../Packets';
import { Guis } from '../player/Inventory';
import { Keybind } from '../player/Keybinding';
import { RotationGCD } from '../player/RotationGCD';
import { Rotations } from '../player/Rotations';
import { ServerInfo } from '../player/ServerInfo';
import Render from '../render/Render';
import { ScheduleTask } from '../ScheduleTask';
import { v5Command } from '../V5Commands';

const SEARCH_OPTIONS = {
    maxIterations: 100000,
    threadCount: 0,
    yawStep: 3.0,
    pitchStep: 2.0,
    newNodeCost: 100.0,
    heuristicWeight: 1.0,
    rayLength: 61.0,
    rewireEpsilon: 1e-9,
};

const PATH_COLORS = {
    pending: Render.Color(0, 170, 255, 180),
    start: Render.Color(80, 255, 140, 180),
    end: Render.Color(255, 90, 90, 180),
};

const MAX_RETRIES = 7;

const DEFAULT_HOP_EXECUTION = {
    smoothAim: true,
    preAimMs: 50,
    postAimMs: 28,
    hopDelayTicks: 2,
    rotationSpeed: 0.95,
    degreesPerSecond: 360,
    minTurnMs: 40,
    msPerDegree: 1.5,
    aimTimeoutMs: 700,
    aimThreshold: 2.2,
    pitchTurnScale: 0.78,
};

const readPathPoints = (pathArr) => {
    if (!pathArr || typeof pathArr.length !== 'number') return [];

    const points = [];
    for (let i = 0; i + 2 < pathArr.length; i += 3) {
        points.push({
            x: Number(pathArr[i]) || 0,
            y: Number(pathArr[i + 1]) || 0,
            z: Number(pathArr[i + 2]) || 0,
        });
    }
    return points;
};

const readAngles = (angleArr) => {
    if (!angleArr || typeof angleArr.length !== 'number') return [];

    const angles = [];
    for (let i = 0; i + 1 < angleArr.length; i += 2) {
        angles.push({
            yaw: Number(angleArr[i]),
            pitch: Number(angleArr[i + 1]),
        });
    }
    return angles;
};

class EtherwarpPathHandler {
    constructor() {
        this.resetState();

        v5Command('etherwarp', (x, y, z) => this.test(x, y, z));

        this.pollTrigger = register('step', () => {
            this.pollSearch();
            this.pollHopExecution();
            this.pollExecutionWait();
        })
            .setFps(60)
            .unregister();
        this.renderTrigger = register('renderWorld', () => this.render()).unregister();
        this.pingTrigger = register('packetReceived', () => this.onCommonPingPacket()).setFilteredClass(CommonPingS2C).unregister();
        this.pollRegistered = false;
        this.renderRegistered = false;
        this.pingRegistered = false;
        register('worldUnload', () => this.handleWorldUnload());
    }

    resetState() {
        this.searchActive = false;
        this.executionActive = false;
        this.executionToken = 0;
        this.stateVersion = 0;
        this.originalSlot = -1;
        this.path = [];
        this.angles = [];
        this.currentGoal = null;
        this.currentRun = null;
        this.commonPingPacketCount = 0;
        this.resetExecutionRuntime();
    }

    updateRuntimeTriggers() {
        if (!this.pollTrigger || !this.renderTrigger || !this.pingTrigger) return;

        const shouldPoll = this.searchActive || this.executionActive || this.pendingHopIndex !== null || this.hopAwaiting;
        if (shouldPoll && !this.pollRegistered) {
            this.pollTrigger.register();
            this.pollRegistered = true;
        } else if (!shouldPoll && this.pollRegistered) {
            this.pollTrigger.unregister();
            this.pollRegistered = false;
        }

        const shouldRender = World.isLoaded() && this.path.length > 0;
        if (shouldRender && !this.renderRegistered) {
            this.renderTrigger.register();
            this.renderRegistered = true;
        } else if (!shouldRender && this.renderRegistered) {
            this.renderTrigger.unregister();
            this.renderRegistered = false;
        }

        const shouldTrackPing = this.executionActive || this.hopAwaiting;
        if (shouldTrackPing && !this.pingRegistered) {
            this.pingTrigger.register();
            this.pingRegistered = true;
        } else if (!shouldTrackPing && this.pingRegistered) {
            this.pingTrigger.unregister();
            this.pingRegistered = false;
        }
    }

    resetExecutionRuntime() {
        this.hopWaitStartedAt = 0;
        this.hopSoftDeadlineAt = 0;
        this.hopHardDeadlineAt = 0;
        this.hopAwaiting = false;
        this.hopRequiredPingPackets = 0;
        this.hopPingStartCount = 0;
        this.finalNode = null;
        this.pendingHopIndex = null;
        this.pendingHopToken = 0;
        this.hopAimStartedAt = 0;
        this.hopAimReadyAt = 0;
        this.hopTurnStartedAt = 0;
        this.hopLastStepAt = 0;
        this.hopInitialTurnDelta = 0;
    }

    test(xArg, yArg, zArg) {
        const x = Math.floor(Number(xArg));
        const y = Math.floor(Number(yArg));
        const z = Math.floor(Number(zArg));
        if (![x, y, z].every(Number.isFinite)) {
            Chat.messagePathfinder('&cUsage: /v5 etherwarp <x> <y> <z>');
            return;
        }
        const goal = { x, y, z };

        this.findPath(goal, { silent: false });
    }

    findPath(goal, options = {}) {
        if (![goal.x, goal.y, goal.z].every(Number.isFinite)) {
            Chat.messagePathfinder('&cInvalid etherwarp coordinates.');
            return false;
        }
        const slot = this.getEtherwarpSlot();
        if (slot < 0) {
            Chat.messagePathfinder('&cNo Aspect of the Void/End found in your hotbar.');
            return false;
        }

        this.cancel(false);

        this.path = [];
        this.angles = [];
        this.currentGoal = goal;
        this.currentRun = {
            silent: options.silent === true,
            autoExecute: options.autoExecute !== false,
            restoreSlot: options.restoreSlot !== false,
            onReady: typeof options.onReady === 'function' ? options.onReady : null,
            onSuccess: typeof options.onSuccess === 'function' ? options.onSuccess : null,
            onFail: typeof options.onFail === 'function' ? options.onFail : null,
            retryCount: 0,
            maxRetries: options.maxRetries || 5,
        };
        this.originalSlot = Player.getHeldItemIndex();
        this.resetExecutionRuntime();

        if (this.startSearch(this.currentGoal, false)) {
            return true;
        }

        if (!this.currentRun) return false;
        const reason = PathManager.getLastError() || 'Unknown error';
        return this.retryPath('Etherpath failed to start: ' + reason);
    }

    cancel(restoreSlot = true) {
        this.searchActive = false;
        PathManager.cancelSearch();
        PathManager.clear();

        this.stopExecution(restoreSlot);
        this.path = [];
        this.angles = [];
        this.currentGoal = null;
        this.currentRun = null;
        this.finalNode = null;
        this.updateRuntimeTriggers();
    }

    isPathing() {
        return this.searchActive || this.executionActive;
    }

    getPlayerSupportBlock() {
        const player = Player.getPlayer();
        const world = World.getWorld();
        if (!player || !world) return null;

        const x = Math.floor(player.getX());
        const z = Math.floor(player.getZ());
        const baseY = Math.floor(player.getY() - 0.001);
        const candidates = [baseY, baseY - 1, baseY - 2, baseY - 3, baseY + 1];

        for (const y of candidates) {
            if (PathManager.isValidEtherwarpLanding(x, y, z)) {
                return { x, y, z };
            }
        }

        return null;
    }

    getEyeHeight() {
        return Number(PathManager.getCurrentEtherwarpEyeHeight());
    }

    isNodeValid(node) {
        if (!node) return false;
        return [node.x, node.y, node.z].every(Number.isFinite);
    }

    getPingDelayTicks() {
        const pingMs = ServerInfo.getPing() || 0;
        return Math.ceil(pingMs / 50) + 2;
    }

    isExecutionContextValid(token) {
        return this.executionActive && this.executionToken === token && this.currentRun !== null;
    }

    isAtNode(node) {
        if (!this.isNodeValid(node)) return false;
        if (!Player.getPlayer()) return false;

        const px = Number(Player.getX());
        const py = Number(Player.getY());
        const pz = Number(Player.getZ());
        if (![px, py, pz].every(Number.isFinite)) return false;

        const sameX = Math.floor(px) === Math.floor(node.x);
        const sameZ = Math.floor(pz) === Math.floor(node.z);
        if (!sameX || !sameZ) return false;

        const yDelta = py - Number(node.y);
        return yDelta >= -2 && yDelta <= 3;
    }

    validatePathData() {
        if (!Array.isArray(this.path) || !Array.isArray(this.angles)) return false;
        if (this.angles.length < this.path.length) return false;

        for (let i = 0; i < this.path.length; i++) {
            if (!this.isNodeValid(this.path[i])) return false;
            const angle = this.angles[i];
            if (!angle || !Number.isFinite(angle.yaw) || !Number.isFinite(angle.pitch)) return false;
        }

        return true;
    }

    startSearch(goal, isRetry = false) {
        const slot = this.getEtherwarpSlot();
        if (slot < 0) {
            this.finishFailure('No Aspect of the Void/End found in your hotbar.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return false;
        }

        this.path = [];
        this.angles = [];
        this.finalNode = null;
        this.preparePlayer(slot);

        const started = PathManager.findEtherwarpPath(
            goal.x,
            goal.y,
            goal.z,
            SEARCH_OPTIONS.maxIterations,
            SEARCH_OPTIONS.threadCount,
            SEARCH_OPTIONS.yawStep,
            SEARCH_OPTIONS.pitchStep,
            SEARCH_OPTIONS.newNodeCost,
            SEARCH_OPTIONS.heuristicWeight,
            SEARCH_OPTIONS.rayLength,
            SEARCH_OPTIONS.rewireEpsilon,
            this.getEyeHeight()
        );

        if (!started) {
            this.searchActive = false;
            this.updateRuntimeTriggers();
            return false;
        }

        this.searchActive = true;
        this.updateRuntimeTriggers();
        const retryRun = this.currentRun;
        const retryText = isRetry && retryRun ? ` &7(retry ${retryRun.retryCount}/${retryRun.maxRetries})` : '';
        this.messagePathfinder('&7Searching etherpath from your eye origin to &c' + goal.x + ', ' + goal.y + ', ' + goal.z + retryText);
        return true;
    }

    clearAttemptForRetry() {
        this.searchActive = false;
        PathManager.cancelSearch();
        PathManager.clear();
        this.path = [];
        this.angles = [];
        this.finalNode = null;
        this.stopExecution(false, true);
    }

    retryPath(reason) {
        const run = this.currentRun;
        const goal = this.currentGoal ? { ...this.currentGoal } : null;
        if (!run || !goal) {
            this.finishFailure(reason, !run || run.restoreSlot !== false);
            return false;
        }

        if (run.retryCount >= run.maxRetries) {
            const retries = run.retryCount;
            const suffix = retries === 1 ? 'retry' : 'retries';
            this.finishFailure(`${reason} after ${retries} ${suffix}.`, run.restoreSlot !== false);
            return false;
        }

        run.retryCount++;
        this.messagePathfinder(`&6Etherpath retry &e(${run.retryCount}/${run.maxRetries})&6: ${reason}`);
        this.clearAttemptForRetry();

        if (this.startSearch(goal, true)) return true;
        if (!this.currentRun) return false;
        const retryReason = PathManager.getLastError() || 'Unknown error';
        this.retryPath('Etherpath failed to start: ' + retryReason);

        return true;
    }

    preparePlayer(slot) {
        this.stateVersion++;
        Keybind.stopMovement();
        Keybind.setKey('shift', true);
        Guis.setItemSlot(slot);
    }

    pollSearch() {
        if (!this.searchActive) return;
        if (PathManager.isSearching()) return;

        this.searchActive = false;

        if (!PathManager.hasEtherwarpPath()) {
            const reason = PathManager.getLastError() || 'No etherpath found';
            this.path = [];
            this.angles = [];
            this.retryPath(reason);
            return;
        }

        this.path = readPathPoints(PathManager.getEtherwarpPathArray());
        this.angles = readAngles(PathManager.getEtherwarpAnglesArray());
        this.finalNode = this.path.length ? this.path[this.path.length - 1] : null;
        this.updateRuntimeTriggers();
        const timeMs = Number(PathManager.getEtherwarpLastTimeMs());
        const nodeCount = this.path.length;

        if (!this.validatePathData()) {
            this.finishFailure('Etherpath returned malformed path data.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return;
        }

        this.messagePathfinder('&aEtherpath ready: &f' + nodeCount + ' nodes' + (Number.isFinite(timeMs) && timeMs >= 0 ? ' in ' + timeMs + 'ms' : ''));
        if (this.currentRun && typeof this.currentRun.onReady === 'function') {
            this.currentRun.onReady(this.path.slice(), this.angles.slice());
        }

        if (!this.currentRun || !this.currentRun.autoExecute) return;

        if (nodeCount <= 0) {
            if (this.currentGoal && this.isAtNode(this.currentGoal)) {
                this.messagePathfinder('&7Already at the destination.');
                this.finishSuccess();
                return;
            }
            this.retryPath('Etherpath returned no hops and destination was not reached.');
            return;
        }

        this.beginExecution();
    }

    beginExecution() {
        if (!this.validatePathData()) {
            this.finishFailure('Etherpath returned malformed hop data.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return false;
        }

        const slot = this.getEtherwarpSlot();
        if (slot < 0) {
            this.finishFailure('No Aspect of the Void/End found in your hotbar.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return false;
        }

        this.executionActive = true;
        this.executionToken++;
        this.resetExecutionRuntime();
        this.finalNode = this.path.length ? this.path[this.path.length - 1] : null;
        this.updateRuntimeTriggers();

        this.preparePlayer(slot);
        ScheduleTask(2, () => this.executePath(this.executionToken));

        this.messagePathfinder('&7Executing etherpath...');
        return true;
    }

    executePath(token) {
        if (!this.isExecutionContextValid(token)) return;
        if (!World.isLoaded()) {
            this.finishFailure('World unloaded during etherwarp.', false);
            return;
        }
        if (!this.ensureEtherwarpHeld(token)) return;

        this.beginHop(token, 0);
    }

    normalizeAngle(angle) {
        let a = angle % 360;
        if (a <= -180) a += 360;
        if (a > 180) a -= 360;
        return a;
    }

    isAimedAtAngles(angles, threshold = 2.5) {
        if (!angles || !Number.isFinite(angles.yaw) || !Number.isFinite(angles.pitch)) return false;
        const current = this.getCurrentRotation();
        const yawDiff = Math.abs(this.normalizeAngle(angles.yaw - current.yaw));
        const pitchDiff = Math.abs(angles.pitch - current.pitch);
        return yawDiff <= threshold && pitchDiff <= threshold;
    }

    readNumber(value, fallback) {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    getHopExecutionOptions() {
        const run = this.currentRun || {};
        const smoothAim = run.smoothAim !== false;
        const rotationSpeed = Math.max(0.35, Math.min(1.5, Number(run.rotationSpeed) || DEFAULT_HOP_EXECUTION.rotationSpeed));
        const degreesPerSecond = Math.max(
            24,
            (Number.isFinite(Number(run.degreesPerSecond)) ? Number(run.degreesPerSecond) : DEFAULT_HOP_EXECUTION.degreesPerSecond) *
                rotationSpeed
        );

        return {
            smoothAim,
            preAimMs: Math.max(0, this.readNumber(run.preAimMs, DEFAULT_HOP_EXECUTION.preAimMs)),
            postAimMs: Math.max(0, this.readNumber(run.postAimMs, DEFAULT_HOP_EXECUTION.postAimMs)),
            hopDelayTicks: Math.max(2, Math.floor(Number(run.hopDelayTicks) || DEFAULT_HOP_EXECUTION.hopDelayTicks)),
            rotationSpeed,
            degreesPerSecond,
            minTurnMs: Math.max(0, this.readNumber(run.minTurnMs, DEFAULT_HOP_EXECUTION.minTurnMs)),
            msPerDegree: Math.max(4, Number(run.msPerDegree) || DEFAULT_HOP_EXECUTION.msPerDegree),
            aimTimeoutMs: Math.max(800, Number(run.aimTimeoutMs) || DEFAULT_HOP_EXECUTION.aimTimeoutMs),
            aimThreshold: Math.max(0.8, Number(run.aimThreshold) || DEFAULT_HOP_EXECUTION.aimThreshold),
            pitchTurnScale: Math.max(0.55, Math.min(1, Number(run.pitchTurnScale) || DEFAULT_HOP_EXECUTION.pitchTurnScale)),
        };
    }

    smoothstep(t) {
        const x = Math.max(0, Math.min(1, t));
        return x * x * (3 - 2 * x);
    }

    getAngleDeltaToTarget(angles) {
        if (!angles || !Number.isFinite(angles.yaw) || !Number.isFinite(angles.pitch)) return 0;
        const current = this.getCurrentRotation();
        const yawDiff = Math.abs(this.normalizeAngle(angles.yaw - current.yaw));
        const pitchDiff = Math.abs(angles.pitch - current.pitch);
        return Math.hypot(yawDiff, pitchDiff);
    }

    getRequiredTurnMs(angles, opts) {
        const delta = Math.max(this.hopInitialTurnDelta || 0, this.getAngleDeltaToTarget(angles));
        return Math.max(opts.minTurnMs, Math.floor(delta * opts.msPerDegree));
    }

    getCurrentRotation() {
        const player = Player.getPlayer();
        const current = RotationGCD.getCurrentRotation(player);
        const yaw = Number(current?.yaw ?? player?.getYaw?.());
        const pitch = Number(current?.pitch ?? player?.getPitch?.());
        return {
            yaw: Number.isFinite(yaw) ? yaw : 0,
            pitch: Number.isFinite(pitch) ? pitch : 0,
        };
    }

    stepTowardAngles(yaw, pitch, degreesPerSecond, pitchTurnScale = 0.78) {
        if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;

        const current = this.getCurrentRotation();
        const currentYaw = current.yaw;
        const currentPitch = current.pitch;

        const deltaYaw = this.normalizeAngle(yaw - currentYaw);
        const deltaPitch = pitch - currentPitch;
        const yawDist = Math.abs(deltaYaw);
        const pitchDist = Math.abs(deltaPitch);
        const distance = Math.hypot(yawDist, pitchDist);
        if (distance <= 0.05) {
            Rotations.applyRotationWithGCD(yaw, pitch);
            return true;
        }

        const now = Date.now();
        const lastStepAt = this.hopLastStepAt || now;
        const deltaMs = Math.max(8, Math.min(100, now - lastStepAt));
        this.hopLastStepAt = now;

        if (distance > this.hopInitialTurnDelta) {
            this.hopInitialTurnDelta = distance;
        }

        const initialDelta = Math.max(distance, this.hopInitialTurnDelta || distance);
        const progress = initialDelta > 0 ? 1 - distance / initialDelta : 1;
        const speedScale = 0.58 + this.smoothstep(progress) * 0.42;
        const maxStep = degreesPerSecond * speedScale * (deltaMs / 1000);
        const yawRatio = yawDist > 0 ? Math.min(1, maxStep / yawDist) : 0;
        const pitchRatio = pitchDist > 0 ? Math.min(1, (maxStep * pitchTurnScale) / pitchDist) : 0;
        const nextYaw = currentYaw + deltaYaw * yawRatio;
        const nextPitch = currentPitch + deltaPitch * pitchRatio;
        Rotations.applyRotationWithGCD(nextYaw, nextPitch);
        return false;
    }

    beginHop(token, index) {
        if (!this.isExecutionContextValid(token)) return;
        if (!World.isLoaded()) {
            this.finishFailure('World unloaded during etherwarp.', false);
            return;
        }

        const angles = this.angles[index];
        if (!angles || !Number.isFinite(angles.yaw) || !Number.isFinite(angles.pitch)) {
            this.finishFailure('Etherpath execution encountered invalid hop angles.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return;
        }
        if (!this.ensureEtherwarpHeld(token, () => this.beginHop(token, index))) return;

        const opts = this.getHopExecutionOptions();
        const now = Date.now();
        this.pendingHopIndex = index;
        this.pendingHopToken = token;
        this.hopAimStartedAt = now;
        this.hopAimReadyAt = 0;
        this.hopTurnStartedAt = 0;
        this.hopLastStepAt = 0;
        this.hopInitialTurnDelta = this.getAngleDeltaToTarget(angles);

        if (!opts.smoothAim) {
            Rotations.applyRotationWithGCD(angles.yaw, angles.pitch);
        }
        this.updateRuntimeTriggers();
    }

    pollHopExecution() {
        if (this.pendingHopIndex === null || !this.executionActive) return;

        const token = this.pendingHopToken;
        if (!this.isExecutionContextValid(token)) {
            this.pendingHopIndex = null;
            return;
        }
        if (!World.isLoaded()) {
            this.pendingHopIndex = null;
            this.finishFailure('World unloaded during etherwarp.', false);
            return;
        }

        const index = this.pendingHopIndex;
        const angles = this.angles[index];
        if (!angles || !Number.isFinite(angles.yaw) || !Number.isFinite(angles.pitch)) {
            this.pendingHopIndex = null;
            this.finishFailure('Etherpath execution encountered invalid hop angles.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return;
        }
        if (!this.ensureEtherwarpHeld(token, () => this.beginHop(token, index))) return;

        const opts = this.getHopExecutionOptions();
        const now = Date.now();
        const elapsed = now - this.hopAimStartedAt;

        if (opts.smoothAim) {
            if (elapsed < opts.preAimMs) return;

            if (!this.hopTurnStartedAt) {
                this.hopTurnStartedAt = now;
                this.hopLastStepAt = now;
            }

            this.stepTowardAngles(angles.yaw, angles.pitch, opts.degreesPerSecond, opts.pitchTurnScale);

            const aimed = this.isAimedAtAngles(angles, opts.aimThreshold);
            const turnElapsed = now - this.hopTurnStartedAt;
            const requiredTurnMs = this.getRequiredTurnMs(angles, opts);
            const turnSettled = aimed && turnElapsed >= requiredTurnMs;

            if (!turnSettled) {
                this.hopAimReadyAt = 0;
                if (elapsed < opts.aimTimeoutMs) return;
                this.stepTowardAngles(angles.yaw, angles.pitch, opts.degreesPerSecond * 1.2, opts.pitchTurnScale);
                if (!this.isAimedAtAngles(angles, opts.aimThreshold)) return;
            }

            if (!this.hopAimReadyAt) this.hopAimReadyAt = now;
            if (now - this.hopAimReadyAt < opts.postAimMs) return;
        } else if (!this.isAimedAtAngles(angles, opts.aimThreshold)) {
            Rotations.applyRotationWithGCD(angles.yaw, angles.pitch);
            if (elapsed < 80) return;
        }

        this.pendingHopIndex = null;
        this.updateRuntimeTriggers();
        this.hopAimReadyAt = 0;
        this.sendEtherwarpClick();

        if (index >= this.path.length - 1) {
            this.startAwaitingFinalArrival(token);
            return;
        }

        const nextIndex = index + 1;
        const delayTicks = opts.smoothAim ? opts.hopDelayTicks : 3;
        ScheduleTask(delayTicks, () => {
            if (this.currentRun === null) return;
            if (!this.isExecutionContextValid(token)) return;
            this.beginHop(token, nextIndex);
        });
    }

    startAwaitingFinalArrival(token) {
        const now = Date.now();
        const estimatedTickDelay = this.getPingDelayTicks();
        const estimatedTickDelayMs = estimatedTickDelay * 50;

        this.hopAwaiting = true;
        this.hopWaitStartedAt = now;
        this.hopSoftDeadlineAt = now + estimatedTickDelayMs;
        this.hopHardDeadlineAt = Math.max(now + 200, this.hopSoftDeadlineAt + 800);
        this.hopRequiredPingPackets = estimatedTickDelay;
        this.hopPingStartCount = this.commonPingPacketCount;
        this.updateRuntimeTriggers();

        this.evaluateFinalArrival(token);
    }

    onCommonPingPacket() {
        this.commonPingPacketCount++;
        if (!this.hopAwaiting || !this.executionActive) return;
        this.evaluateFinalArrival(this.executionToken);
    }

    pollExecutionWait() {
        if (!this.hopAwaiting || !this.executionActive) return;
        this.evaluateFinalArrival(this.executionToken);
    }

    evaluateFinalArrival(token) {
        if (!this.isExecutionContextValid(token)) return;
        if (!this.hopAwaiting) return;

        const finalNode = this.finalNode || (this.path.length ? this.path[this.path.length - 1] : null);
        if (!this.isNodeValid(finalNode)) {
            this.finishFailure('Etherpath execution encountered malformed final node data.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return;
        }

        if (this.isAtNode(finalNode)) {
            this.hopAwaiting = false;
            this.messagePathfinder('&aEtherpath complete.');
            this.finishSuccess();
            return;
        }

        const observedPackets = this.commonPingPacketCount - this.hopPingStartCount;
        if (observedPackets >= this.hopRequiredPingPackets && Date.now() >= this.hopSoftDeadlineAt) {
            this.retryPath('Etherpath final destination arrival timeout.');
            return;
        }

        if (Date.now() >= this.hopHardDeadlineAt) {
            this.retryPath('Etherpath final destination arrival timeout.');
        }
    }

    sendEtherwarpClick() {
        const yaw = Number.parseFloat(Player.getYaw());
        const pitch = Number.parseFloat(Player.getPitch());
        Client.sendSequencedPacket((sequence) => new PlayerInteractItemC2S(MCHand.MAIN_HAND, sequence, yaw, pitch));
    }

    stopExecution(restoreSlot = true, preserveOriginalSlot = false) {
        const hasPreparedState = this.executionActive || this.originalSlot !== -1;
        const currentOriginalSlot = this.originalSlot;
        const slotToRestore = restoreSlot && currentOriginalSlot >= 0 && currentOriginalSlot <= 8 ? currentOriginalSlot : -1;
        const cleanupVersion = ++this.stateVersion;

        this.executionToken++;
        this.executionActive = false;
        this.hopAwaiting = false;
        this.resetExecutionRuntime();
        this.originalSlot = preserveOriginalSlot ? currentOriginalSlot : -1;
        this.updateRuntimeTriggers();

        if (!hasPreparedState) return;

        ScheduleTask(0, () => {
            if (this.stateVersion !== cleanupVersion) return;

            Keybind.setKey('shift', false);
            Keybind.stopMovement();

            if (slotToRestore !== -1) Guis.setItemSlot(slotToRestore);
        });
    }

    getEtherwarpSlot() {
        const aotv = Guis.findItemInHotbar('Aspect of the Void');
        if (aotv !== -1) return aotv;
        return Guis.findItemInHotbar('Aspect of the End');
    }

    ensureEtherwarpHeld(token, resumeTask) {
        const continuation = typeof resumeTask === 'function' ? resumeTask : () => this.executePath(token);
        const slot = this.getEtherwarpSlot();
        if (slot < 0) {
            this.finishFailure('Lost Aspect of the Void/End during etherpath execution.', !this.currentRun || this.currentRun.restoreSlot !== false);
            return false;
        }

        if (Player.getHeldItemIndex() === slot) return true;

        Guis.setItemSlot(slot);
        ScheduleTask(1, continuation);
        return false;
    }

    render() {
        if (!World.isLoaded()) return;
        if (!this.path.length) return;

        for (let i = 0; i < this.path.length; i++) {
            const point = this.path[i];
            const pointVec = new Vec3d(point.x, point.y, point.z);
            const centerVec = new Vec3d(point.x + 0.5, point.y + 1.05, point.z + 0.5);
            const boxColor = i === 0 ? PATH_COLORS.start : i === this.path.length - 1 ? PATH_COLORS.end : PATH_COLORS.pending;

            Render.drawStyledBox(pointVec, boxColor, boxColor, 3, false);

            if (i >= this.path.length - 1) continue;

            const next = this.path[i + 1];
            Render.drawLine(centerVec, new Vec3d(next.x + 0.5, next.y + 1.05, next.z + 0.5), PATH_COLORS.pending, 3, false);
        }
    }

    handleWorldUnload() {
        if (this.currentRun) {
            this.finishFailure('World unloaded during etherwarp.', false);
            return;
        }
        this.cancel(true);
    }

    finishSuccess() {
        const currentGoal = this.currentGoal ? { ...this.currentGoal } : null;
        const run = this.currentRun;
        const onSuccess = run && typeof run.onSuccess === 'function' ? run.onSuccess : null;
        const restoreSlot = !run || run.restoreSlot !== false;

        PathManager.clear();
        this.searchActive = false;
        this.path = [];
        this.angles = [];
        this.currentGoal = null;
        this.currentRun = null;
        this.finalNode = null;
        this.stopExecution(restoreSlot);
        this.updateRuntimeTriggers();

        if (typeof onSuccess !== 'function') return;
        onSuccess(currentGoal);
    }

    finishFailure(reason, restoreSlot = true) {
        const failureReason = reason || 'Unknown etherwarp failure';
        const run = this.currentRun;
        const onFail = run && typeof run.onFail === 'function' ? run.onFail : null;
        const silent = !!(run && run.silent === true);

        PathManager.cancelSearch();
        PathManager.clear();
        this.searchActive = false;
        this.path = [];
        this.angles = [];
        this.currentGoal = null;
        this.currentRun = null;
        this.finalNode = null;
        this.stopExecution(restoreSlot);
        this.updateRuntimeTriggers();
        if (!silent) {
            Chat.messagePathfinder('&c' + failureReason);
        }

        if (typeof onFail !== 'function') return;
        onFail(failureReason);
    }

    messagePathfinder(message) {
        const run = this.currentRun;
        if (run && run.silent === true) return;
        Chat.messagePathfinder(message);
    }
}

export const EtherwarpPathfinder = new EtherwarpPathHandler();
