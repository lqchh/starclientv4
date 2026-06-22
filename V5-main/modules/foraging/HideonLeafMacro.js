import { BP, PathManager } from '../../utils/Constants';
import { MacroState } from '../../utils/MacroState';
import { ModuleBase } from '../../utils/ModuleBase';
import { EtherwarpPathfinder } from '../../utils/pathfinder/EtherwarpPathfinder';
import PathConfig from '../../utils/pathfinder/PathConfig';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { Aote } from '../../utils/pathfinder/PathWalker/PathAote';
import { Guis } from '../../utils/player/Inventory';
import { Keybind } from '../../utils/player/Keybinding';
import { Rotations } from '../../utils/player/Rotations';
import { Raytrace } from '../../utils/Raytrace';
import { ScheduleTask } from '../../utils/ScheduleTask';
import { Utils } from '../../utils/Utils';
import { getHideonLeafTargets } from './HideonLeafESP';

const ShulkerBulletEntity = net.minecraft.entity.projectile.ShulkerBulletEntity;

const OPEN_PROGRESS_THRESHOLD = 0.15;
const OPEN_CONSECUTIVE_TICKS = 2;
const OPEN_WAIT_MS = 4500;
const OPEN_RETRY_LIMIT = 2;
const CLOSED_PROGRESS_THRESHOLD = 0.05;
const CLOSED_CONSECUTIVE_TICKS = 4;
const TARGET_BLACKLIST_MS = 8000;
const CAPTURE_BLACKLIST_MS = 4500;
const PATH_FAIL_BLACKLIST_MS = 9000;

const STAND_DIRECT_RANGE = 5.5;
const STAND_CENTER_DIST = 0.42;
const STAND_DRIFT_DIST = 0.85;
const STAND_RECENT_MS = 1600;
const STAND_JUMP_FORCE_MS = 1200;
const WALK_ONLY_RETREAT_TARGETS = new Set(['-595,113,-39']);
const RETREAT_RADIUS = 3.9;
const RETREAT_MIN_DIST = 3.5;
const RETREAT_MAX_DIST = 5.0;
const RETREAT_TIMEOUT_MS = 2600;
const RETREAT_DIRECT_TIMEOUT_MS = 1200;
const RETREAT_DIRECT_GOAL_TOLERANCE = 0.65;
const RETREAT_WALK_MAX_DIST = 5.0;
const RETREAT_SCAN_RADIUS = 5;
const SPECIAL_RETREAT_SCAN_RADIUS = 5;
const NON_ETHERWARP_RETREAT_RANGE = 14;
const NON_ETHERWARP_LANDING_STEP = 0.2;
const NON_ETHERWARP_GOAL_TOLERANCE = 1.35;
const ETHERWARP_TRAVEL_MIN_DIST = 5;
const ETHERWARP_LANDING_SCAN_RADIUS = 8;
const ETHERWARP_LANDING_MAX_DIST = 11;
const ETHERWARP_LANDING_BLACKLIST_MS = 6000;
const AOTV_TRAVEL_TUNING = {
    FINAL_POINT_NO_AOTE_RADIUS: 4,
    MINIMUM_TOTAL_PATH_LENGTH: 12,
    AOTE_MIN_GAIN: 6,
    AOTE_STRAIGHTNESS_THRESHOLD: 45,
    WALKER_AOTE_COOLDOWN_TICKS: 8,
};

const REQUIRED_DEFLECTS = 3;
const MAX_PROJECTILE_CLICKS = 9;
const PROJECTILE_CLICK_COOLDOWN_MS = 520;
const PROJECTILE_DEDUPE_MS = 750;
const DEFLECT_TIMEOUT_MS = 9000;
const CAPTURE_STATUS_WAIT_MS = 1700;

const STATES = {
    IDLE: 'Idle',
    SCANNING: 'Scanning',
    PATHING: 'Pathing',
    STANDING: 'Standing On Box',
    WAITING_OPEN: 'Waiting Open',
    RETREATING: 'Retreating',
    DEFLECTING: 'Deflecting',
    VERIFYING_CAPTURE: 'Verifying Capture',
};

class HideonLeafMacro extends ModuleBase {
    constructor() {
        super({
            name: 'HideonLeaf Macro',
            subcategory: 'Foraging',
            description: 'Captures HideonLeaf shards using AOTV travel and a Fishing Net.',
            tooltip: 'Paths to HideonLeaf boxes, waits until they open, retreats, then nets their projectiles.',
            theme: '#4cbf7b',
            showEnabledToggle: false,
            isMacro: true,
            autoDisableOnWorldUnload: true,
        });

        this.bindToggleKey();

        this.state = STATES.IDLE;
        this.status = 'Idle';
        this.loopToken = 0;
        this.actionToken = 0;

        this.currentTarget = null;
        this.currentTargetId = null;
        this.pathRequestActive = false;
        this.pathRequestId = 0;
        this.blacklistedTargets = new Map();
        this.blacklistedEtherwarpLandings = new Map();

        this.openStartedAt = 0;
        this.openConsecutiveTicks = 0;
        this.closeConsecutiveTicks = 0;
        this.openRetries = 0;
        this.stoodOnTargetAt = 0;
        this.standJumpUntil = 0;
        this.captureRetries = 0;
        this.captureConfirmedAt = 0;

        this.retreatGoal = null;
        this.retreatStartedAt = 0;
        this.retreatDirectStartedAt = 0;
        this.retreatClickedAt = 0;
        this.retreatActionActive = false;
        this.retreatPathActive = false;
        this.retreatWalkAttempted = false;

        this.seenProjectiles = new Map();
        this.deflectStartedAt = 0;
        this.verifyStartedAt = 0;
        this.lastProjectileClickAt = 0;
        this.currentDeflects = 0;
        this.totalDeflects = 0;
        this.completedTargets = 0;

        this.autoEnabledEsp = false;
        this.previousWalkerAoteEnabled = null;
        this.previousWalkerAoteCooldown = null;
        this.previousAoteTuning = null;
        this.aoteSlot = -1;
        this.netSlot = -1;

        this.on('tick', () => this.runLoop(this.loopToken));
        this.on('chat', (event) => this.onChat(event));

        this.createOverlay([
            {
                title: 'Status',
                data: {
                    State: () => this.state,
                    Status: () => this.status,
                    Deflects: () => `${this.currentDeflects}/${REQUIRED_DEFLECTS}`,
                    Retries: () => this.captureRetries,
                    Completed: () => this.completedTargets,
                    'Shards per hour': () => this.getCompletedPerHourDisplay(),
                },
            },
        ]);
    }

    onEnable() {
        this.loopToken++;
        this.actionToken++;
        this.resetRuntime();
        this.state = STATES.SCANNING;
        this.status = 'Starting';

        if (!this.validateStart()) return;

        this.previousWalkerAoteEnabled = PathConfig.WALKER_AOTE_ENABLED;
        this.previousWalkerAoteCooldown = PathConfig.WALKER_AOTE_COOLDOWN_TICKS;
        this.previousAoteTuning = {
            FINAL_POINT_NO_AOTE_RADIUS: Aote.FINAL_POINT_NO_AOTE_RADIUS,
            MINIMUM_TOTAL_PATH_LENGTH: Aote.MINIMUM_TOTAL_PATH_LENGTH,
            AOTE_MIN_GAIN: Aote.AOTE_MIN_GAIN,
            AOTE_STRAIGHTNESS_THRESHOLD: Aote.AOTE_STRAIGHTNESS_THRESHOLD,
        };
        PathConfig.WALKER_AOTE_ENABLED = true;
        PathConfig.WALKER_AOTE_COOLDOWN_TICKS = AOTV_TRAVEL_TUNING.WALKER_AOTE_COOLDOWN_TICKS;
        Aote.FINAL_POINT_NO_AOTE_RADIUS = AOTV_TRAVEL_TUNING.FINAL_POINT_NO_AOTE_RADIUS;
        Aote.MINIMUM_TOTAL_PATH_LENGTH = AOTV_TRAVEL_TUNING.MINIMUM_TOTAL_PATH_LENGTH;
        Aote.AOTE_MIN_GAIN = AOTV_TRAVEL_TUNING.AOTE_MIN_GAIN;
        Aote.AOTE_STRAIGHTNESS_THRESHOLD = AOTV_TRAVEL_TUNING.AOTE_STRAIGHTNESS_THRESHOLD;
        this.ensureEspEnabled();
        this.message('&aEnabled');
    }

    onDisable() {
        this.loopToken++;
        this.actionToken++;
        this.state = STATES.IDLE;
        this.status = 'Disabled';
        this.cancelPathing();
        this.stopControls();
        Rotations.stopRotation();
        this.restorePathConfig();
        this.restoreEspState();
        this.resetTargetRuntime();
        this.message('&cDisabled');
    }

    validateStart() {
        if (!World.isLoaded() || Utils.area() !== 'Galatea') {
            return this.failStart('&cYou must be on Galatea to use this macro.');
        }

        this.aoteSlot = this.findAoteSlot();
        if (this.aoteSlot === -1) {
            return this.failStart('&cNo Aspect of the Void/End found in your hotbar.');
        }

        this.netSlot = this.findFishingNetSlot();
        if (this.netSlot === -1) {
            return this.failStart('&cNo Fishing Net found in your hotbar.');
        }

        return true;
    }

    failStart(message) {
        this.message(message);
        this.state = STATES.IDLE;
        this.status = 'Start failed';
        ScheduleTask(1, () => {
            if (this.enabled) this.toggle(false);
        });
        return false;
    }

    resetRuntime() {
        this.cancelPathing();
        this.stopControls();
        this.blacklistedTargets.clear();
        this.blacklistedEtherwarpLandings.clear();
        this.completedTargets = 0;
        this.totalDeflects = 0;
        this.netSlot = -1;
        this.aoteSlot = -1;
        this.resetTargetRuntime();
    }

    resetTargetRuntime() {
        this.currentTarget = null;
        this.currentTargetId = null;
        this.openStartedAt = 0;
        this.openConsecutiveTicks = 0;
        this.closeConsecutiveTicks = 0;
        this.openRetries = 0;
        this.stoodOnTargetAt = 0;
        this.standJumpUntil = 0;
        this.captureRetries = 0;
        this.captureConfirmedAt = 0;
        this.retreatGoal = null;
        this.retreatStartedAt = 0;
        this.retreatDirectStartedAt = 0;
        this.retreatClickedAt = 0;
        this.retreatActionActive = false;
        this.retreatPathActive = false;
        this.retreatWalkAttempted = false;
        this.seenProjectiles.clear();
        this.deflectStartedAt = 0;
        this.verifyStartedAt = 0;
        this.lastProjectileClickAt = 0;
        this.currentDeflects = 0;
    }

    getCompletedPerHourDisplay() {
        const startedAt = this.getMacroStartTime() || Date.now();
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs <= 0) return '0.00';

        const hours = elapsedMs / 3600000;
        const rate = this.completedTargets / hours;
        if (!Number.isFinite(rate)) return '0.00';
        return rate.toFixed(2);
    }

    runLoop(token) {
        if (!this.enabled || token !== this.loopToken) return;

        if (!World.isLoaded() || Utils.area() !== 'Galatea') {
            this.message('&cLeft Galatea or world unloaded. Disabling.');
            this.toggle(false);
            return;
        }

        this.cleanupBlacklist();

        switch (this.state) {
            case STATES.SCANNING:
                this.handleScanning(token);
                break;
            case STATES.PATHING:
                this.handlePathing(token);
                break;
            case STATES.STANDING:
                this.handleStanding(token);
                break;
            case STATES.WAITING_OPEN:
                this.handleWaitingOpen(token);
                break;
            case STATES.RETREATING:
                this.handleRetreating(token);
                break;
            case STATES.DEFLECTING:
                this.handleDeflecting(token);
                break;
            case STATES.VERIFYING_CAPTURE:
                this.handleVerifyCapture(token);
                break;
        }
    }

    onChat(event) {
        if (!this.enabled) return;

        const text = this.getChatText(event);
        if (!this.isHideonLeafCaptureMessage(text)) return;

        this.captureConfirmedAt = Date.now();
        if (!this.currentTarget) return;

        this.finishCurrentTarget(true, 'HideonLeaf lost the fight');
    }

    getChatText(event) {
        try {
            const raw = event?.message?.getUnformattedText?.()
                ?? event?.message
                ?? ChatLib.getChatMessage?.(event, true)
                ?? '';
            return ChatLib.removeFormatting(String(raw)).trim();
        } catch (e) {
            return '';
        }
    }

    isHideonLeafCaptureMessage(text) {
        const clean = String(text || '').toLowerCase();
        return clean.includes('hideonleaf') && clean.includes('lost the fight');
    }

    ensureEspEnabled() {
        const espModule = MacroState.getModule('HideonLeaf ESP');
        if (!espModule || espModule.enabled) return;
        this.autoEnabledEsp = true;
        espModule.toggle(true);
    }

    restoreEspState() {
        if (!this.autoEnabledEsp) return;
        const espModule = MacroState.getModule('HideonLeaf ESP');
        if (espModule?.enabled) espModule.toggle(false);
        this.autoEnabledEsp = false;
    }

    restorePathConfig() {
        if (this.previousWalkerAoteEnabled === null) return;
        PathConfig.WALKER_AOTE_ENABLED = this.previousWalkerAoteEnabled;
        if (this.previousWalkerAoteCooldown !== null) PathConfig.WALKER_AOTE_COOLDOWN_TICKS = this.previousWalkerAoteCooldown;
        if (this.previousAoteTuning) {
            Aote.FINAL_POINT_NO_AOTE_RADIUS = this.previousAoteTuning.FINAL_POINT_NO_AOTE_RADIUS;
            Aote.MINIMUM_TOTAL_PATH_LENGTH = this.previousAoteTuning.MINIMUM_TOTAL_PATH_LENGTH;
            Aote.AOTE_MIN_GAIN = this.previousAoteTuning.AOTE_MIN_GAIN;
            Aote.AOTE_STRAIGHTNESS_THRESHOLD = this.previousAoteTuning.AOTE_STRAIGHTNESS_THRESHOLD;
        }
        this.previousWalkerAoteEnabled = null;
        this.previousWalkerAoteCooldown = null;
        this.previousAoteTuning = null;
    }

    handleScanning(token) {
        const target = this.pickTarget();
        if (!target) {
            this.status = 'No HideonLeaf targets';
            this.stopControls();
            return;
        }

        this.setCurrentTarget(target);
        this.startPathToTarget(target, token);
    }

    handlePathing(token) {
        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.abortCurrentTarget('Target vanished', TARGET_BLACKLIST_MS);
            return;
        }

        if (this.getFlatDistanceToTarget(target) <= STAND_DIRECT_RANGE) {
            this.cancelPathing();
            this.beginStanding(token, 'Close enough to stand');
            return;
        }

        if (EtherwarpPathfinder.isPathing()) {
            this.status = 'Etherwarping to box';
            return;
        }

        if (!this.pathRequestActive && !Pathfinder.isPathing()) {
            this.startPathToTarget(target, token);
        }
    }

    handleStanding(token) {
        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.abortCurrentTarget('Target vanished', TARGET_BLACKLIST_MS);
            return;
        }

        const centered = this.markTargetStandIfCentered(target);
        if (this.confirmTargetOpen(target) && this.hasRecentlyStoodOnTarget()) {
            this.beginRetreat(token);
            return;
        }

        this.driveOntoTarget(target, true);
        this.status = 'Moving onto box';

        if (centered) {
            this.beginWaitingOpen('Centered on box');
            return;
        }

        this.handleOpenTimeout(token);
    }

    handleWaitingOpen(token) {
        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.abortCurrentTarget('Target vanished', TARGET_BLACKLIST_MS);
            return;
        }

        this.markTargetStandIfCentered(target);
        if (this.confirmTargetOpen(target) && this.hasRecentlyStoodOnTarget()) {
            this.beginRetreat(token);
            return;
        }

        const flat = this.getFlatDistanceToTarget(target);
        if (flat > STAND_DRIFT_DIST) {
            this.state = STATES.STANDING;
            this.status = 'Recentering on box';
            this.driveOntoTarget(target, true);
            return;
        }

        this.driveOntoTarget(target, Date.now() < this.standJumpUntil);
        this.status = 'Waiting for open';
        this.handleOpenTimeout(token);
    }

    handleRetreating(token) {
        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.beginVerifyCapture('Waiting for capture chat');
            return;
        }

        if (this.retreatPathActive || Pathfinder.isPathing()) {
            this.status = 'Pathing to retreat point';
            return;
        }

        if (this.isInRetreatRange(target)) {
            this.beginDeflecting(token);
            return;
        }

        if (this.tryDirectRetreat(target)) return;

        // If direct movement could not finish quickly, use pathing as a fallback.
        if (!this.retreatWalkAttempted || Date.now() - this.retreatStartedAt > RETREAT_TIMEOUT_MS) {
            this.retreatStartedAt = Date.now();
            this.startRetreatPath(token);
        }
    }

    handleDeflecting(token) {
        if (this.captureConfirmedAt) {
            this.finishCurrentTarget(true, 'HideonLeaf lost the fight');
            return;
        }

        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.beginVerifyCapture('Waiting for capture chat');
            return;
        }

        if (!this.ensureHeld(this.netSlot)) {
            this.status = 'Swapping to Fishing Net';
            return;
        }

        this.stopMovementOnly();
        Rotations.rotateToVector(this.getTargetAimPoint(target), true, 1.0);
        this.status = 'Waiting for projectile';

        const projectile = this.findProjectileForCurrentTarget(target);
        if (projectile) {
            this.tryNetProjectile(projectile);
        }

        if (this.currentDeflects >= REQUIRED_DEFLECTS) {
            this.beginVerifyCapture('Waiting for capture chat');
            return;
        }

        if (Date.now() - this.deflectStartedAt > DEFLECT_TIMEOUT_MS) {
            this.beginVerifyCapture('Projectile timeout; waiting close');
        }
    }

    handleVerifyCapture(token) {
        if (this.captureConfirmedAt) {
            this.finishCurrentTarget(true, 'HideonLeaf lost the fight');
            return;
        }

        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.status = 'Waiting for capture chat';
            return;
        }

        this.stopMovementOnly();
        if (this.ensureHeld(this.netSlot)) {
            const projectile = this.findProjectileForCurrentTarget(target);
            if (projectile) this.tryNetProjectile(projectile);
        }
        Rotations.rotateToVector(this.getTargetAimPoint(target), true, 1.0);

        if (this.confirmTargetClosed(target)) {
            this.restartCurrentTarget(token, 'No capture chat; reopening');
            return;
        }

        this.status = Date.now() - this.verifyStartedAt >= CAPTURE_STATUS_WAIT_MS
            ? 'Waiting close to retry'
            : 'Waiting for capture chat';
    }

    setCurrentTarget(target) {
        this.currentTarget = target;
        this.currentTargetId = this.getEntityId(target);
        this.openStartedAt = Date.now();
        this.openConsecutiveTicks = 0;
        this.closeConsecutiveTicks = 0;
        this.openRetries = 0;
        this.stoodOnTargetAt = 0;
        this.standJumpUntil = 0;
        this.captureRetries = 0;
        this.captureConfirmedAt = 0;
        this.retreatGoal = null;
        this.retreatStartedAt = 0;
        this.retreatDirectStartedAt = 0;
        this.retreatClickedAt = 0;
        this.retreatActionActive = false;
        this.retreatPathActive = false;
        this.retreatWalkAttempted = false;
        this.currentDeflects = 0;
        this.seenProjectiles.clear();
    }

    startPathToTarget(target, token) {
        const flat = this.getFlatDistanceToTarget(target);
        if (flat <= STAND_DIRECT_RANGE) {
            this.beginStanding(token, 'Close target');
            return;
        }

        const goals = this.getApproachGoals(target);
        if (!goals.length) {
            this.abortCurrentTarget('No approach goals', PATH_FAIL_BLACKLIST_MS);
            return;
        }

        if (flat >= ETHERWARP_TRAVEL_MIN_DIST) {
            const etherwarpGoal = this.findEtherwarpApproachGoal(target, goals);
            if (etherwarpGoal && this.startEtherwarpPathToTarget(target, token, goals, etherwarpGoal)) return;
        }

        this.startWalkPathToTarget(target, token, goals);
    }

    startWalkPathToTarget(target, token, goals = null) {
        const activeGoals = goals || this.getApproachGoals(target);
        if (!activeGoals.length) {
            this.abortCurrentTarget('No approach goals', PATH_FAIL_BLACKLIST_MS);
            return;
        }

        const requestId = ++this.pathRequestId;
        this.pathRequestActive = true;
        this.state = STATES.PATHING;
        this.status = 'Pathing to box';

        EtherwarpPathfinder.cancel(true);
        Pathfinder.resetPath();
        Pathfinder.findPath(activeGoals, (success) => {
            if (!this.enabled || token !== this.loopToken || requestId !== this.pathRequestId) return;

            this.pathRequestActive = false;
            if (!success) {
                this.abortCurrentTarget('Path failed', PATH_FAIL_BLACKLIST_MS);
                return;
            }

            this.beginStanding(token, 'Path complete');
        }, false, this.getCurrentWalkStartPoints());
    }

    startEtherwarpPathToTarget(target, token, goals, etherwarpGoal) {
        const requestId = ++this.pathRequestId;
        this.pathRequestActive = true;
        this.state = STATES.PATHING;
        this.status = 'Etherwarping to box';

        Pathfinder.resetPath();
        const started = EtherwarpPathfinder.findPath(etherwarpGoal, {
            silent: true,
            restoreSlot: true,
            maxRetries: 3,
            ...this.getEtherwarpTravelOptions(),
            onSuccess: () => {
                if (!this.enabled || token !== this.loopToken || requestId !== this.pathRequestId) return;

                this.pathRequestActive = false;
                const live = this.getLiveCurrentTarget();
                if (!live) {
                    this.abortCurrentTarget('Target vanished', TARGET_BLACKLIST_MS);
                    return;
                }

                if (this.getFlatDistanceToTarget(live) <= STAND_DIRECT_RANGE) {
                    this.beginStanding(token, 'Etherwarp complete');
                    return;
                }

                this.startWalkPathToTarget(live, token, this.getApproachGoals(live));
            },
            onFail: () => {
                if (!this.enabled || token !== this.loopToken || requestId !== this.pathRequestId) return;

                this.pathRequestActive = false;
                this.blacklistEtherwarpLanding(etherwarpGoal);
                const live = this.getLiveCurrentTarget();
                if (!live) {
                    this.abortCurrentTarget('Target vanished', TARGET_BLACKLIST_MS);
                    return;
                }

                this.startWalkPathToTarget(live, token, goals);
            },
        });

        if (started) return true;

        this.pathRequestActive = false;
        this.blacklistEtherwarpLanding(etherwarpGoal);
        return false;
    }

    getEtherwarpTravelOptions() {
        return {
            preAimMs: 45,
            postAimMs: 25,
            hopDelayTicks: 2,
            rotationSpeed: 1.05,
            minTurnMs: 35,
            degreesPerSecond: 380,
            msPerDegree: 1.5,
            aimThreshold: 0.9,
            pitchTurnScale: 0.78,
            aimTimeoutMs: 700,
        };
    }

    getCurrentWalkStartPoints() {
        const player = Player.getPlayer();
        if (!player) return null;

        const x = Math.floor(Player.getX());
        const z = Math.floor(Player.getZ());
        const preferredY = Math.floor(Player.getY()) - 1;
        const support = this.resolveStandSupport(x, z, preferredY);
        if (support) return [[support.x, support.y, support.z]];

        return [[x, preferredY, z]];
    }

    beginStanding(token, reason) {
        this.cancelPathing();
        this.actionToken++;
        this.state = STATES.STANDING;
        this.status = reason || 'Standing on box';
        this.openStartedAt = Date.now();
        this.openConsecutiveTicks = 0;
        this.stoodOnTargetAt = 0;
        this.standJumpUntil = Date.now() + STAND_JUMP_FORCE_MS;
    }

    beginWaitingOpen(reason) {
        this.state = STATES.WAITING_OPEN;
        this.status = reason || 'Waiting for open';
    }

    handleOpenTimeout(token) {
        if (Date.now() - this.openStartedAt <= OPEN_WAIT_MS) return;

        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.abortCurrentTarget('Target vanished', TARGET_BLACKLIST_MS);
            return;
        }

        if (this.openRetries < OPEN_RETRY_LIMIT) {
            this.openRetries++;
            this.openStartedAt = Date.now();
            this.openConsecutiveTicks = 0;
            this.state = STATES.STANDING;
            this.status = `Retrying open (${this.openRetries}/${OPEN_RETRY_LIMIT})`;
            this.driveOntoTarget(target, true);
            return;
        }

        this.abortCurrentTarget('Open timeout', TARGET_BLACKLIST_MS);
    }

    confirmTargetOpen(target) {
        const progress = this.getTargetOpenProgress(target);
        if (progress > OPEN_PROGRESS_THRESHOLD) this.openConsecutiveTicks++;
        else this.openConsecutiveTicks = 0;

        return this.openConsecutiveTicks >= OPEN_CONSECUTIVE_TICKS;
    }

    confirmTargetClosed(target) {
        const progress = this.getTargetOpenProgress(target);
        if (progress <= CLOSED_PROGRESS_THRESHOLD) this.closeConsecutiveTicks++;
        else this.closeConsecutiveTicks = 0;

        return this.closeConsecutiveTicks >= CLOSED_CONSECUTIVE_TICKS;
    }

    getTargetOpenProgress(target) {
        try {
            return Number(target?.toMC?.()?.getOpenProgress?.(1.0)) || 0;
        } catch (e) {
            return 0;
        }
    }

    beginRetreat(token) {
        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.beginVerifyCapture('Waiting for capture chat');
            return;
        }

        this.state = STATES.RETREATING;
        this.status = 'Retreating';
        this.actionToken++;
        this.stopControls();
        Keybind.setKey('shift', false);

        // Always walk to retreat point instead of AOTV teleporting
        // AOTV teleport was causing the player to fly off unpredictably
        this.retreatGoal = this.findRetreatGoal(target, false);
        this.retreatStartedAt = Date.now();
        this.retreatDirectStartedAt = this.retreatStartedAt;
        this.retreatClickedAt = 0;
        this.retreatActionActive = false;
        this.retreatPathActive = false;

        if (!this.retreatGoal) {
            this.abortCurrentTarget('No retreat point', TARGET_BLACKLIST_MS);
            return;
        }

        this.status = 'Quick retreat';
        this.tryDirectRetreat(target);
    }

    startRetreatPath(token) {
        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.beginVerifyCapture('Waiting for capture chat');
            return;
        }

        if (this.isInRetreatRange(target)) {
            this.beginDeflecting(token);
            return;
        }

        const goal = this.findRetreatPathGoal(target);
        if (!goal) {
            this.abortCurrentTarget('No retreat point', TARGET_BLACKLIST_MS);
            return;
        }

        this.retreatWalkAttempted = true;
        const requestId = ++this.pathRequestId;
        this.retreatPathActive = true;
        this.pathRequestActive = true;
        this.status = 'Walking to retreat point';

        Pathfinder.resetPath();
        Pathfinder.findPath([[goal.x, goal.y, goal.z]], (success) => {
            if (!this.enabled || token !== this.loopToken || requestId !== this.pathRequestId) return;

            this.retreatPathActive = false;
            this.pathRequestActive = false;

            const live = this.getLiveCurrentTarget();
            if (!live) {
                this.beginVerifyCapture('Waiting for capture chat');
                return;
            }

            if (this.isInRetreatRange(live)) {
                this.beginDeflecting(token);
                return;
            }

            if (!success) {
                this.abortCurrentTarget('Retreat failed', TARGET_BLACKLIST_MS);
                return;
            }

            this.retreatStartedAt = Date.now();
            this.retreatDirectStartedAt = this.retreatStartedAt;
            this.status = 'Correcting retreat distance';
        }, false, this.getCurrentWalkStartPoints());
    }

    tryDirectRetreat(target) {
        if (!target) return false;

        if (!this.retreatGoal) {
            this.retreatGoal = this.findRetreatGoal(target, false);
            this.retreatDirectStartedAt = Date.now();
        }
        if (!this.retreatGoal) return false;

        const goalX = this.retreatGoal.x + 0.5;
        const goalY = this.retreatGoal.y + 1;
        const goalZ = this.retreatGoal.z + 0.5;
        const goalFlat = Math.hypot(goalX - Player.getX(), goalZ - Player.getZ());
        const timedOut = Date.now() - this.retreatDirectStartedAt > RETREAT_DIRECT_TIMEOUT_MS;

        if (goalFlat <= RETREAT_DIRECT_GOAL_TOLERANCE && !this.isInRetreatRange(target)) {
            this.retreatGoal = this.findRetreatGoal(target, false);
            this.retreatDirectStartedAt = Date.now();
            if (!this.retreatGoal) return false;
            return this.tryDirectRetreat(target);
        }

        if (timedOut && goalFlat > RETREAT_DIRECT_GOAL_TOLERANCE) {
            this.stopMovementOnly();
            return false;
        }

        const shouldJump = goalY > Player.getY() + 0.15;
        Keybind.setKey('shift', false);
        Keybind.setKeysForStraightLineCoords(goalX, Player.getY(), goalZ, shouldJump, true);
        Keybind.setKey('sprint', goalFlat > 1.15);
        Rotations.rotateToVector(this.getTargetAimPoint(target), true, 0.95);
        this.status = `Quick retreat ${this.getFlatDistanceToTarget(target).toFixed(1)}m`;
        return true;
    }

    beginDeflecting(token) {
        this.cancelPathing();
        this.stopControls();
        this.state = STATES.DEFLECTING;
        this.status = 'Deflecting projectiles';
        this.currentDeflects = 0;
        this.seenProjectiles.clear();
        this.deflectStartedAt = Date.now();
        this.lastProjectileClickAt = 0;
        this.ensureHeld(this.netSlot);
    }

    beginVerifyCapture(reason = 'Waiting for capture chat') {
        this.state = STATES.VERIFYING_CAPTURE;
        this.status = reason;
        this.verifyStartedAt = Date.now();
        this.closeConsecutiveTicks = 0;
    }

    restartCurrentTarget(token, reason) {
        const target = this.getLiveCurrentTarget();
        if (!target) {
            this.status = 'Waiting for target to reappear';
            return;
        }

        this.captureRetries++;
        this.cancelPathing();
        this.stopControls();
        Rotations.stopRotation();

        this.openStartedAt = Date.now();
        this.openConsecutiveTicks = 0;
        this.closeConsecutiveTicks = 0;
        this.openRetries = 0;
        this.stoodOnTargetAt = 0;
        this.standJumpUntil = Date.now() + STAND_JUMP_FORCE_MS;
        this.retreatGoal = null;
        this.retreatStartedAt = 0;
        this.retreatDirectStartedAt = 0;
        this.retreatClickedAt = 0;
        this.retreatActionActive = false;
        this.retreatPathActive = false;
        this.retreatWalkAttempted = false;
        this.currentDeflects = 0;
        this.seenProjectiles.clear();
        this.deflectStartedAt = 0;
        this.verifyStartedAt = 0;
        this.lastProjectileClickAt = 0;

        this.status = `${reason} (${this.captureRetries})`;
        this.startPathToTarget(target, token);
    }

    finishCurrentTarget(success, reason) {
        const target = this.getLiveCurrentTarget() || this.currentTarget;
        if (target) this.blacklistTarget(target, CAPTURE_BLACKLIST_MS);
        if (success) this.completedTargets++;

        this.resetTargetRuntime();
        this.stopControls();
        Rotations.stopRotation();
        this.state = STATES.SCANNING;
        this.status = reason || 'Next target';
    }

    abortCurrentTarget(reason, durationMs = TARGET_BLACKLIST_MS) {
        const target = this.getLiveCurrentTarget() || this.currentTarget;
        if (target) this.blacklistTarget(target, durationMs);
        this.cancelPathing();
        this.resetTargetRuntime();
        this.stopControls();
        Rotations.stopRotation();
        this.state = STATES.SCANNING;
        this.status = reason || 'Skipping target';
    }

    pickTarget() {
        const targets = getHideonLeafTargets()
            .filter((entity) => this.isValidTarget(entity))
            .filter((entity) => !this.isTargetBlacklisted(entity));

        targets.sort((a, b) => this.getDistanceToTarget(a) - this.getDistanceToTarget(b));
        return targets[0] || null;
    }

    isValidTarget(entity) {
        if (!entity) return false;
        try {
            return !entity.isDead();
        } catch (e) {
            return false;
        }
    }

    getLiveCurrentTarget() {
        if (!this.currentTarget) return null;

        const targets = getHideonLeafTargets().filter((target) => this.isValidTarget(target));
        const match = targets.find((target) => this.sameEntity(target, this.currentTarget));
        if (match) {
            this.currentTarget = match;
            this.currentTargetId = this.getEntityId(match);
            return match;
        }

        if (!this.isValidTarget(this.currentTarget)) return null;
        return null;
    }

    sameEntity(a, b) {
        const aId = this.getEntityId(a);
        const bId = this.getEntityId(b);
        if (aId !== null && bId !== null && aId === bId) return true;
        return this.getPositionKey(a) === this.getPositionKey(b);
    }

    findAoteSlot() {
        const aotv = Guis.findItemInHotbar('Aspect of the Void');
        if (aotv !== -1) return aotv;
        return Guis.findItemInHotbar('Aspect of the End');
    }

    findFishingNetSlot() {
        return Guis.findItemInHotbar('Fishing Net');
    }

    ensureHeld(slot) {
        if (slot < 0 || slot > 8) return false;
        if (Player.getHeldItemIndex() === slot) return true;
        Guis.setItemSlot(slot);
        return false;
    }

    markTargetStandIfCentered(target) {
        if (!this.isCenteredOnTarget(target)) return false;
        this.stoodOnTargetAt = Date.now();
        return true;
    }

    isCenteredOnTarget(target) {
        return this.getFlatDistanceToTarget(target) <= STAND_CENTER_DIST;
    }

    hasRecentlyStoodOnTarget() {
        return this.stoodOnTargetAt > 0 && Date.now() - this.stoodOnTargetAt <= STAND_RECENT_MS;
    }

    driveOntoTarget(target, jump) {
        const center = this.getTargetCenter(target);
        const flat = this.getFlatDistanceToTarget(target);
        const shouldMove = flat > STAND_CENTER_DIST;
        const shouldJump = !!jump && (flat > 0.18 || Date.now() < this.standJumpUntil);

        Keybind.setKey('shift', false);
        Keybind.setKey('sprint', false);

        if (shouldMove) {
            Keybind.setKeysForStraightLineCoords(center.x, Player.getY(), center.z, shouldJump, true);
        } else {
            Keybind.stopMovement();
            Keybind.setKey('space', shouldJump);
        }

        Rotations.rotateToVector(this.getTargetAimPoint(target), true, 0.8);
    }

    stopControls() {
        Keybind.unpressKeys();
        Keybind.setKey('leftclick', false);
    }

    stopMovementOnly() {
        Keybind.stopMovement();
        Keybind.setKey('space', false);
        Keybind.setKey('shift', false);
        Keybind.setKey('sprint', false);
    }

    cancelPathing() {
        this.pathRequestId++;
        this.pathRequestActive = false;
        this.retreatPathActive = false;
        EtherwarpPathfinder.cancel(true);
        Pathfinder.resetPath();
    }

    getApproachGoals(target) {
        const block = this.getTargetBlock(target);
        if (!block) return [];

        const goals = [];
        const seen = new Set();
        const offsets = [
            [0, 0],
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
            [2, 0],
            [-2, 0],
            [0, 2],
            [0, -2],
        ];

        offsets.forEach(([dx, dz]) => {
            const x = block.x + dx;
            const z = block.z + dz;
            const support = this.resolveStandSupport(x, z, block.y - 1);
            if (!support) return;

            const key = `${support.x},${support.y},${support.z}`;
            if (seen.has(key)) return;
            seen.add(key);
            goals.push([support.x, support.y, support.z]);
        });

        return goals;
    }

    findEtherwarpApproachGoal(target, walkGoals = []) {
        const block = this.getTargetBlock(target);
        const center = this.getTargetCenter(target);
        if (!block || !center) return null;

        const sortOrigin = EtherwarpPathfinder.getPlayerSupportBlock() || {
            x: Math.floor(Player.getX()),
            y: Math.floor(Player.getY()),
            z: Math.floor(Player.getZ()),
        };
        const anchors = [
            { x: block.x, y: block.y - 1, z: block.z },
            { x: block.x, y: block.y, z: block.z },
            ...walkGoals.map(([x, y, z]) => ({ x, y, z })),
        ];
        const seen = new Set();
        const candidates = [];

        anchors.forEach((anchor) => {
            let result = null;
            try {
                result = PathManager.getEtherwarpLandingCandidates(
                    anchor.x,
                    anchor.y,
                    anchor.z,
                    ETHERWARP_LANDING_SCAN_RADIUS,
                    ETHERWARP_LANDING_MAX_DIST,
                    sortOrigin.x,
                    sortOrigin.y,
                    sortOrigin.z
                );
            } catch (e) {
                result = null;
            }

            const goals = result?.goals;
            if (!goals || typeof goals.length !== 'number') return;

            for (let i = 0; i + 2 < goals.length; i += 3) {
                const goal = {
                    x: Math.floor(Number(goals[i])),
                    y: Math.floor(Number(goals[i + 1])),
                    z: Math.floor(Number(goals[i + 2])),
                };
                if (![goal.x, goal.y, goal.z].every(Number.isFinite)) continue;

                const key = this.getBlockKey(goal);
                if (seen.has(key) || this.isEtherwarpLandingBlacklisted(goal)) continue;
                seen.add(key);

                if (!this.isValidEtherwarpLanding(goal)) continue;

                const targetFlat = Math.hypot(goal.x + 0.5 - center.x, goal.z + 0.5 - center.z);
                if (targetFlat > ETHERWARP_LANDING_MAX_DIST + 1) continue;

                const approachDistance = this.getClosestWalkGoalDistance(goal, walkGoals);
                const playerFlat = Math.hypot(goal.x + 0.5 - Player.getX(), goal.z + 0.5 - Player.getZ());
                const heightPenalty = Math.abs((goal.y + 1) - Player.getY()) * 0.3;
                const targetPenalty = Math.abs(targetFlat - STAND_DIRECT_RANGE) * 0.45;
                candidates.push({
                    ...goal,
                    score: approachDistance + targetPenalty + heightPenalty + playerFlat * 0.04,
                });
            }
        });

        candidates.sort((a, b) => a.score - b.score);
        return candidates[0] || null;
    }

    getClosestWalkGoalDistance(goal, walkGoals) {
        if (!walkGoals?.length) return 0;

        return walkGoals.reduce((best, [x, y, z]) => {
            const distance = Math.hypot(goal.x - x, goal.y - y, goal.z - z);
            return Math.min(best, distance);
        }, Number.MAX_VALUE);
    }

    isValidEtherwarpLanding(goal) {
        try {
            if (PathManager.isValidEtherwarpLanding(goal.x, goal.y, goal.z)) return true;
        } catch (e) {
            return this.isStandableSupport(goal.x, goal.y, goal.z);
        }

        return false;
    }

    findRetreatGoal(target, requireAotvClear = false) {
        const center = this.getTargetCenter(target);
        const block = this.getTargetBlock(target);
        if (!center || !block) return null;

        const preferredAngle = this.getRetreatBaseAngle(center);
        const candidates = [];
        const seen = new Set();

        for (let dx = -RETREAT_SCAN_RADIUS; dx <= RETREAT_SCAN_RADIUS; dx++) {
            for (let dz = -RETREAT_SCAN_RADIUS; dz <= RETREAT_SCAN_RADIUS; dz++) {
                if (dx === 0 && dz === 0) continue;

                const x = block.x + dx;
                const z = block.z + dz;
                const support = this.resolveStandSupport(x, z, block.y - 1);
                if (!support) continue;

                const key = this.getBlockKey(support);
                if (!key || seen.has(key)) continue;
                seen.add(key);

                const flat = Math.hypot(support.x + 0.5 - center.x, support.z + 0.5 - center.z);
                if (!this.isRetreatFlatAllowed(flat)) continue;
                if (requireAotvClear && !this.canAotvRetreatTo(support)) continue;

                candidates.push({
                    x: support.x,
                    y: support.y,
                    z: support.z,
                    flat,
                    score: this.scoreRetreatSupport(support, target, center, flat, preferredAngle),
                });
            }
        }

        candidates.sort((a, b) => a.score - b.score);
        return candidates[0] || null;
    }

    scoreRetreatSupport(support, target, center, flat, preferredAngle) {
        const playerDist = Math.hypot(support.x + 0.5 - Player.getX(), support.z + 0.5 - Player.getZ());
        const heightPenalty = Math.abs((support.y + 1) - Player.getY()) * 0.45;
        const idealPenalty = Math.abs(flat - RETREAT_RADIUS) * 0.55;
        const candidateAngle = Math.atan2(support.z + 0.5 - center.z, support.x + 0.5 - center.x);
        const anglePenalty = this.angleDistance(candidateAngle, preferredAngle) * 0.45;
        const sightPenalty = this.hasRetreatSightline(support, target) ? 0 : 5.5;

        return playerDist + heightPenalty + idealPenalty + anglePenalty + sightPenalty;
    }

    isRetreatFlatAllowed(flat) {
        return Number.isFinite(flat) && flat >= RETREAT_MIN_DIST && flat <= RETREAT_MAX_DIST;
    }

    angleDistance(a, b) {
        let diff = Math.abs(a - b) % (Math.PI * 2);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        return diff;
    }

    hasRetreatSightline(support, target) {
        const rawAim = this.getTargetAimPoint(target);
        const aim = Array.isArray(rawAim)
            ? { x: Number(rawAim[0]), y: Number(rawAim[1]), z: Number(rawAim[2]) }
            : rawAim;
        if (!aim || ![aim.x, aim.y, aim.z].every(Number.isFinite)) return false;

        const startX = support.x + 0.5;
        const startY = support.y + 2.45;
        const startZ = support.z + 0.5;
        const block = this.getTargetBlock(target);

        try {
            return Raytrace.isLineClear(startX, startY, startZ, aim.x, aim.y, aim.z, block?.x, block?.y, block?.z);
        } catch (e) {
            return true;
        }
    }

    findRetreatPathGoal(target) {
        if (this.isWalkOnlyRetreatTarget(target)) {
            return this.findSpecialWalkRetreatGoal(target);
        }

        const walkGoal = this.findPostAotvWalkGoal(target);
        if (walkGoal) return walkGoal;
        return this.retreatGoal || this.findRetreatGoal(target);
    }

    findSpecialWalkRetreatGoal(target) {
        const center = this.getTargetCenter(target);
        const block = this.getTargetBlock(target);
        if (!center || !block) return null;

        const candidates = [];
        const playerX = Math.floor(Player.getX());
        const playerY = Math.floor(Player.getY()) - 1;
        const playerZ = Math.floor(Player.getZ());

        for (let dx = -SPECIAL_RETREAT_SCAN_RADIUS; dx <= SPECIAL_RETREAT_SCAN_RADIUS; dx++) {
            for (let dz = -SPECIAL_RETREAT_SCAN_RADIUS; dz <= SPECIAL_RETREAT_SCAN_RADIUS; dz++) {
                const x = block.x + dx;
                const z = block.z + dz;
                if (x === block.x && z === block.z) continue;

                const support = this.resolveStandSupport(x, z, block.y - 1);
                if (!support) continue;

                const flat = Math.hypot(support.x + 0.5 - center.x, support.z + 0.5 - center.z);
                if (!this.isRetreatFlatAllowed(flat)) continue;

                const playerDist = Math.hypot(support.x - playerX, support.z - playerZ);
                const heightPenalty = Math.abs((support.y + 1) - Player.getY()) * 0.5;
                const distancePenalty = Math.abs(flat - RETREAT_RADIUS) * 0.55;
                const sightPenalty = this.hasRetreatSightline(support, target) ? 0 : 5.5;
                candidates.push({
                    x: support.x,
                    y: support.y,
                    z: support.z,
                    score: playerDist + heightPenalty + distancePenalty + sightPenalty,
                });
            }
        }

        candidates.sort((a, b) => a.score - b.score);
        return candidates[0] || null;
    }

    findPostAotvWalkGoal(target) {
        if (this.retreatWalkAttempted) return null;

        const center = this.getTargetCenter(target);
        const block = this.getTargetBlock(target);
        if (!center || !block) return null;

        const currentFlat = this.getFlatDistanceToTarget(target);
        if (currentFlat >= RETREAT_MIN_DIST) return null;

        const playerX = Math.floor(Player.getX());
        const playerY = Math.floor(Player.getY()) - 1;
        const playerZ = Math.floor(Player.getZ());
        const candidates = [];

        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                if (dx === 0 && dz === 0) continue;

                const walkDistance = Math.hypot(dx, dz);
                if (walkDistance > RETREAT_WALK_MAX_DIST) continue;

                const support = this.resolveStandSupport(playerX + dx, playerZ + dz, playerY);
                if (!support) continue;

                const flat = Math.hypot(support.x + 0.5 - center.x, support.z + 0.5 - center.z);
                if (flat <= currentFlat + 0.45 && flat < RETREAT_MIN_DIST) continue;
                if (!this.isRetreatFlatAllowed(flat)) continue;

                const heightPenalty = Math.abs((support.y + 1) - Player.getY()) * 0.45;
                const idealPenalty = Math.abs(flat - RETREAT_RADIUS) * 0.55;
                const sightPenalty = this.hasRetreatSightline(support, target) ? 0 : 5.5;
                candidates.push({
                    x: support.x,
                    y: support.y,
                    z: support.z,
                    score: walkDistance + heightPenalty + idealPenalty + sightPenalty,
                });
            }
        }

        candidates.sort((a, b) => a.score - b.score);
        return candidates[0] || null;
    }

    getRetreatBaseAngle(center) {
        const dx = Player.getX() - center.x;
        const dz = Player.getZ() - center.z;
        if (Math.hypot(dx, dz) > 0.2) return Math.atan2(dz, dx);

        const yawRad = (-Player.getYaw() * Math.PI) / 180;
        const forwardX = Math.sin(yawRad);
        const forwardZ = Math.cos(yawRad);
        return Math.atan2(forwardZ, forwardX);
    }

    resolveStandSupport(x, z, preferredY) {
        const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];
        for (const dy of offsets) {
            const y = Math.floor(preferredY + dy);
            if (this.isStandableSupport(x, y, z)) return { x, y, z };
        }
        return null;
    }

    canAotvRetreatTo(goal) {
        return !!this.estimateSafeNonEtherwarpLanding(goal);
    }

    estimateSafeNonEtherwarpLanding(goal) {
        if (!goal || !this.isStandableSupport(goal.x, goal.y, goal.z)) return null;

        const player = Player.getPlayer();
        const eye = player?.getEyePos?.();
        if (!player || !eye) return null;

        const eyeHeight = this.getPlayerEyeHeight(eye);
        const aim = {
            x: goal.x + 0.5,
            y: goal.y + 1.2,
            z: goal.z + 0.5,
        };
        const direction = this.getNormalizedDirection(eye, aim);
        if (!direction) return null;

        const range = Math.max(8, Math.min(NON_ETHERWARP_RETREAT_RANGE, Number(Aote.AOTE_RANGE) || NON_ETHERWARP_RETREAT_RANGE));
        let stopDistance = range;

        for (let distance = 0; distance <= range; distance += NON_ETHERWARP_LANDING_STEP) {
            const point = {
                x: eye.x + direction.x * distance,
                y: eye.y + direction.y * distance,
                z: eye.z + direction.z * distance,
            };

            if (!this.isTeleportBodyClear(point, eyeHeight)) {
                stopDistance = Math.max(0, distance - NON_ETHERWARP_LANDING_STEP);
                break;
            }
        }

        const landingEye = {
            x: eye.x + direction.x * stopDistance,
            y: eye.y + direction.y * stopDistance,
            z: eye.z + direction.z * stopDistance,
        };
        const support = this.resolveTeleportLandingSupport(landingEye, eyeHeight);
        if (!support) return null;

        const goalDistance = Math.hypot(support.x - goal.x, support.y - goal.y, support.z - goal.z);
        if (goalDistance > NON_ETHERWARP_GOAL_TOLERANCE) return null;

        return support;
    }

    getPlayerEyeHeight(eye) {
        const height = Number(eye?.y) - Number(Player.getY());
        if (Number.isFinite(height) && height > 0.8 && height < 2.2) return height;
        return 1.62;
    }

    getNormalizedDirection(start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dy, dz);
        if (!Number.isFinite(length) || length <= 0.05) return null;

        return {
            x: dx / length,
            y: dy / length,
            z: dz / length,
        };
    }

    isTeleportBodyClear(eyePoint, eyeHeight) {
        const feetY = eyePoint.y - eyeHeight;
        const x = Math.floor(eyePoint.x);
        const z = Math.floor(eyePoint.z);
        return this.isClearBlock(x, Math.floor(feetY), z)
            && this.isClearBlock(x, Math.floor(feetY + 1), z)
            && this.isClearBlock(x, Math.floor(eyePoint.y), z);
    }

    resolveTeleportLandingSupport(eyePoint, eyeHeight) {
        const feetY = eyePoint.y - eyeHeight;
        const x = Math.floor(eyePoint.x);
        const z = Math.floor(eyePoint.z);
        const support = this.resolveStandSupport(x, z, Math.floor(feetY) - 1);
        if (!support) return null;

        const supportedFeetY = support.y + 1;
        if (Math.abs(supportedFeetY - feetY) > 1.25) return null;

        return support;
    }

    isWalkOnlyRetreatTarget(target) {
        const block = this.getTargetBlock(target);
        if (!block) return false;
        if (WALK_ONLY_RETREAT_TARGETS.has(`${block.x},${block.y},${block.z}`)) return true;
        return block.x === -595 && block.z === -39 && Math.abs(block.y - 113) <= 1;
    }

    isStandableSupport(x, y, z) {
        return this.hasCollision(x, y, z) && this.isClearBlock(x, y + 1, z) && this.isClearBlock(x, y + 2, z);
    }

    hasCollision(x, y, z) {
        const world = World.getWorld();
        if (!world) return false;
        try {
            const pos = new BP(Math.floor(x), Math.floor(y), Math.floor(z));
            const state = world.getBlockState(pos);
            if (!state) return false;
            const shape = state.getCollisionShape(world, pos);
            return !!shape && !shape.isEmpty();
        } catch (e) {
            return false;
        }
    }

    isClearBlock(x, y, z) {
        const world = World.getWorld();
        if (!world) return false;
        try {
            const pos = new BP(Math.floor(x), Math.floor(y), Math.floor(z));
            const state = world.getBlockState(pos);
            if (!state) return false;
            const shape = state.getCollisionShape(world, pos);
            return !shape || shape.isEmpty();
        } catch (e) {
            return false;
        }
    }

    isInRetreatRange(target) {
        const flat = this.getFlatDistanceToTarget(target);
        const yDelta = Math.abs(Player.getY() - target.getY());
        return flat >= RETREAT_MIN_DIST && flat <= RETREAT_MAX_DIST && yDelta <= 5.5;
    }

    findProjectileForCurrentTarget(target) {
        this.cleanupProjectileDedupe();

        const projectiles = World.getAllEntitiesOfType(ShulkerBulletEntity)
            .filter((entity) => entity && !entity.isDead())
            .filter((entity) => !this.isProjectileRecentlyHandled(entity))
            .filter((entity) => this.isProjectileRelevant(entity, target));

        projectiles.sort((a, b) => this.getDistanceToPlayerEntity(a) - this.getDistanceToPlayerEntity(b));
        return projectiles[0] || null;
    }

    isProjectileRelevant(projectile, target) {
        const ownerId = this.getProjectileOwnerId(projectile);
        if (ownerId !== null && this.currentTargetId !== null && ownerId === this.currentTargetId) return true;

        const point = this.getEntityCenter(projectile);
        if (!point) return false;

        const targetPoint = this.getTargetAimPoint(target);
        const eye = Player.getPlayer()?.getEyePos?.();
        if (!targetPoint || !eye) return false;

        const nearTarget = this.distance(point, targetPoint) <= 12;
        const nearPlayer = this.distance(point, eye) <= 9;
        const nearLine = this.distancePointToSegment(point, targetPoint, eye) <= 3.25;

        return nearTarget && nearPlayer && nearLine;
    }

    tryNetProjectile(projectile) {
        if (this.currentDeflects >= MAX_PROJECTILE_CLICKS) return false;
        if (Date.now() - this.lastProjectileClickAt < PROJECTILE_CLICK_COOLDOWN_MS) return false;
        if (!this.ensureHeld(this.netSlot)) return false;

        const key = this.getProjectileKey(projectile);
        this.seenProjectiles.set(key, Date.now());
        Keybind.rightClick();
        this.currentDeflects++;
        this.totalDeflects++;
        this.lastProjectileClickAt = Date.now();
        this.deflectStartedAt = this.lastProjectileClickAt;
        this.status = `Net deflect ${this.currentDeflects}/${REQUIRED_DEFLECTS}`;
        return true;
    }

    isProjectileRecentlyHandled(projectile) {
        const key = this.getProjectileKey(projectile);
        const handledAt = this.seenProjectiles.get(key);
        return !!handledAt && Date.now() - handledAt < PROJECTILE_DEDUPE_MS;
    }

    cleanupProjectileDedupe() {
        const now = Date.now();
        for (const [key, handledAt] of this.seenProjectiles.entries()) {
            if (now - handledAt > PROJECTILE_DEDUPE_MS) this.seenProjectiles.delete(key);
        }
    }

    blacklistTarget(target, durationMs) {
        const expiresAt = Date.now() + durationMs;
        const idKey = this.getTargetKey(target);
        const posKey = this.getPositionKey(target);
        if (idKey) this.blacklistedTargets.set(idKey, expiresAt);
        if (posKey) this.blacklistedTargets.set(posKey, expiresAt);
    }

    isTargetBlacklisted(target) {
        return this.isBlacklistKeyActive(this.getTargetKey(target)) || this.isBlacklistKeyActive(this.getPositionKey(target));
    }

    isBlacklistKeyActive(key) {
        if (!key) return false;
        const expiresAt = this.blacklistedTargets.get(key);
        if (!expiresAt) return false;
        if (expiresAt <= Date.now()) {
            this.blacklistedTargets.delete(key);
            return false;
        }
        return true;
    }

    cleanupBlacklist() {
        const now = Date.now();
        for (const [key, expiresAt] of this.blacklistedTargets.entries()) {
            if (expiresAt <= now) this.blacklistedTargets.delete(key);
        }
        for (const [key, expiresAt] of this.blacklistedEtherwarpLandings.entries()) {
            if (expiresAt <= now) this.blacklistedEtherwarpLandings.delete(key);
        }
    }

    blacklistEtherwarpLanding(goal) {
        const key = this.getBlockKey(goal);
        if (!key) return;
        this.blacklistedEtherwarpLandings.set(key, Date.now() + ETHERWARP_LANDING_BLACKLIST_MS);
    }

    isEtherwarpLandingBlacklisted(goal) {
        const key = this.getBlockKey(goal);
        if (!key) return false;

        const expiresAt = this.blacklistedEtherwarpLandings.get(key);
        if (!expiresAt) return false;
        if (expiresAt <= Date.now()) {
            this.blacklistedEtherwarpLandings.delete(key);
            return false;
        }

        return true;
    }

    getBlockKey(block) {
        if (!block) return null;
        const x = Math.floor(Number(block.x));
        const y = Math.floor(Number(block.y));
        const z = Math.floor(Number(block.z));
        if (![x, y, z].every(Number.isFinite)) return null;
        return `${x},${y},${z}`;
    }

    getEntityId(entity) {
        try {
            const id = entity?.toMC?.()?.getId?.();
            return Number.isFinite(Number(id)) ? Number(id) : null;
        } catch (e) {
            return null;
        }
    }

    getProjectileOwnerId(projectile) {
        try {
            const owner = projectile?.toMC?.()?.getOwner?.();
            const id = owner?.getId?.();
            return Number.isFinite(Number(id)) ? Number(id) : null;
        } catch (e) {
            return null;
        }
    }

    getProjectileKey(projectile) {
        const id = this.getEntityId(projectile);
        if (id !== null) return `projectile:${id}`;
        const center = this.getEntityCenter(projectile);
        if (!center) return `projectile:unknown:${Date.now()}`;
        return `projectile:${Math.floor(center.x * 10)},${Math.floor(center.y * 10)},${Math.floor(center.z * 10)}`;
    }

    getTargetKey(target) {
        const id = this.getEntityId(target);
        if (id !== null) return `hideonleaf:${id}`;
        return this.getPositionKey(target);
    }

    getPositionKey(target) {
        const block = this.getTargetBlock(target);
        if (!block) return null;
        return `hideonleaf-pos:${block.x},${block.y},${block.z}`;
    }

    getTargetBlock(target) {
        if (!target) return null;
        return {
            x: Math.floor(Number(target.getX())),
            y: Math.floor(Number(target.getY())),
            z: Math.floor(Number(target.getZ())),
        };
    }

    getTargetCenter(target) {
        return this.getEntityCenter(target) || {
            x: Number(target.getX()) + 0.5,
            y: Number(target.getY()) + 0.5,
            z: Number(target.getZ()) + 0.5,
        };
    }

    getTargetAimPoint(target) {
        const center = this.getEntityCenter(target);
        if (center) return center;
        return [target.getX(), target.getY() + 0.6, target.getZ()];
    }

    getEntityCenter(entity) {
        try {
            const box = entity?.toMC?.()?.getBoundingBox?.();
            if (!box) return null;
            return {
                x: (box.minX + box.maxX) / 2,
                y: box.minY + (box.maxY - box.minY) * 0.62,
                z: (box.minZ + box.maxZ) / 2,
            };
        } catch (e) {
            try {
                return {
                    x: Number(entity.getX()),
                    y: Number(entity.getY()) + 0.5,
                    z: Number(entity.getZ()),
                };
            } catch (ignored) {
                return null;
            }
        }
    }

    getFlatDistanceToTarget(target) {
        const center = this.getTargetCenter(target);
        return Math.hypot(Player.getX() - center.x, Player.getZ() - center.z);
    }

    getDistanceToTarget(target) {
        const center = this.getTargetCenter(target);
        return Math.hypot(Player.getX() - center.x, Player.getY() - center.y, Player.getZ() - center.z);
    }

    getDistanceToPlayerEntity(entity) {
        const center = this.getEntityCenter(entity);
        if (!center) return Number.MAX_VALUE;
        return Math.hypot(Player.getX() - center.x, Player.getY() - center.y, Player.getZ() - center.z);
    }

    distance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }

    distancePointToSegment(point, start, end) {
        const vx = end.x - start.x;
        const vy = end.y - start.y;
        const vz = end.z - start.z;
        const wx = point.x - start.x;
        const wy = point.y - start.y;
        const wz = point.z - start.z;
        const lengthSq = vx * vx + vy * vy + vz * vz;
        if (lengthSq <= 0.0001) return this.distance(point, start);

        const t = Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / lengthSq));
        return Math.hypot(point.x - (start.x + vx * t), point.y - (start.y + vy * t), point.z - (start.z + vz * t));
    }
}

new HideonLeafMacro();
