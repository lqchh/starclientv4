import { ModuleBase } from '../../utils/ModuleBase';
import { MacroState } from '../../utils/MacroState';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { Keybind } from '../../utils/player/Keybinding';
import { Rotations } from '../../utils/player/Rotations';
import { Raytrace } from '../../utils/Raytrace';
import { NukerUtils } from '../../utils/NukerUtils';
import { getActiveBerberis, isWiltedBerberisBlock } from './WiltedBerberisESP';

/**
 * Wilted Berberis Macro
 *
 * Farming mechanic:
 *   1. Only ONE dead_bush at a time has purple (portal) particles — that's the active berberis.
 *   2. You must break that specific bush (with Wand of Farming equipped).
 *   3. After breaking it, particles transfer to a NEARBY dead_bush — forming a chain.
 *   4. The macro must detect the particle transfer in real-time and path/walk to the next one.
 *
 * Flow:
 *   SCANNING  → wait for ESP to detect particles on a bush
 *   PATHING   → pathfind to the active berberis
 *   HARVESTING → rotate + click (or nuker) the active bush
 *   → back to SCANNING (particles move to next bush)
 */

const MAX_REACH = 4.5;
const AIM_FAIL_BLACKLIST_MS = 2000;
const MAX_TARGET_CLICK_RETRIES = 3;
const HARVEST_MODES = ['Click', 'Nuker'];
const BERBERIS_AIM_OFFSETS = [
    [0.5, 0.5, 0.5],
    [0.5, 0.3, 0.5],
    [0.45, 0.3, 0.5],
    [0.55, 0.3, 0.5],
    [0.5, 0.3, 0.45],
    [0.5, 0.3, 0.55],
    [0.5, 0.7, 0.5],
    [0.5, 0.1, 0.5],
];

class WiltedBerberisMacro extends ModuleBase {
    constructor() {
        super({
            name: 'Wilted Berberis Macro',
            subcategory: 'Farming',
            description: 'Follows the purple particle chain to farm Wilted Berberis.',
            tooltip:
                'Detects the active Wilted Berberis via portal particles, pathfinds to it, breaks it, ' +
                'then follows the particle transfer to the next one in a continuous loop.',
            theme: '#c9873a',
            showEnabledToggle: false,
            isMacro: true,
        });

        this.bindToggleKey();

        this.STATES = {
            IDLE: 'Idle',
            SCANNING: 'Scanning',
            PATHING: 'Pathing',
            HARVESTING: 'Harvesting',
            WAITING_TRANSFER: 'Waiting for Transfer',
        };

        this.status = this.STATES.IDLE;
        this.loopToken = 0;
        this.autoEnabledEsp = false;
        this.pathRequestActive = false;
        this.pathRequestId = 0;
        this.harvestRequestActive = false;
        this.harvestMode = HARVEST_MODES[0];
        this.totalHarvested = 0;
        this.pathsCompleted = 0;
        this.lastTarget = null;
        this.lastBreakTime = 0;
        this.transferWaitStart = 0;
        this.blacklistedPositions = new Map();
        this.retryCount = 0;

        this.on('tick', () => this.runLoop(this.loopToken));

        this.addMultiToggle(
            'Harvest Mode',
            HARVEST_MODES,
            true,
            (selected) => {
                const enabled = Array.isArray(selected) ? selected.find((item) => item.enabled) : null;
                this.harvestMode = enabled?.name || HARVEST_MODES[0];
            },
            'Click rotates + left-clicks. Nuker packet-breaks.',
            HARVEST_MODES[0]
        );

        this.createOverlay([
            {
                title: 'Status',
                data: {
                    State: () => this.status,
                    Mode: () => this.harvestMode,
                    Harvested: () => this.totalHarvested,
                    Paths: () => this.pathsCompleted,
                },
            },
        ]);
    }

    onEnable() {
        this.loopToken++;
        this.status = this.STATES.SCANNING;
        this.pathRequestActive = false;
        this.pathRequestId = 0;
        this.harvestRequestActive = false;
        this.totalHarvested = 0;
        this.pathsCompleted = 0;
        this.lastTarget = null;
        this.lastBreakTime = 0;
        this.transferWaitStart = 0;
        this.blacklistedPositions.clear();
        this.retryCount = 0;
        this.message('&aEnabled');
        this.ensureEspEnabled();
    }

    onDisable() {
        this.loopToken++;
        this.status = this.STATES.IDLE;
        this.cancelCurrentPathing();
        this.harvestRequestActive = false;
        Rotations.stopRotation();
        Keybind.stopMovement();
        this.restoreEspState();
        this.message('&cDisabled');
    }

    ensureEspEnabled() {
        const espModule = MacroState.getModule('Wilted Berberis ESP');
        if (!espModule || espModule.enabled) return;
        this.autoEnabledEsp = true;
        espModule.toggle(true);
    }

    restoreEspState() {
        if (!this.autoEnabledEsp) return;
        const espModule = MacroState.getModule('Wilted Berberis ESP');
        if (espModule?.enabled) espModule.toggle(false);
        this.autoEnabledEsp = false;
    }

    // ─── Main Loop ───────────────────────────────────────────────

    runLoop(token) {
        if (!this.enabled || token !== this.loopToken) return;

        this.cleanupBlacklist();

        // Get the currently active berberis from ESP (particle-confirmed)
        const active = getActiveBerberis();

        // Try nuker opportunistically if target is in range
        if (active && this.harvestMode === 'Nuker' && this.isBlockInReach(active)) {
            if (isWiltedBerberisBlock(active.x, active.y, active.z)) {
                this.nukeTarget(active, token);
                return;
            }
        }

        // If we're actively pathing, check if we should cancel (target changed or reached)
        if (this.pathRequestActive || Pathfinder.isPathing()) {
            if (active && this.lastTarget) {
                // If the active berberis changed while pathing, cancel and repath
                if (active.x !== this.lastTarget.x || active.y !== this.lastTarget.y || active.z !== this.lastTarget.z) {
                    this.cancelCurrentPathing();
                    // Fall through to handle the new target
                } else {
                    this.status = this.STATES.PATHING;
                    return;
                }
            } else {
                this.status = this.STATES.PATHING;
                return;
            }
        }

        // If we're in the middle of a click harvest rotation
        if (this.harvestRequestActive || Rotations.isRotating) {
            this.status = this.STATES.HARVESTING;
            return;
        }

        // === STATE: No active target detected ===
        if (!active) {
            // After breaking a bush, wait briefly for particles to transfer
            if (this.lastBreakTime > 0 && Date.now() - this.lastBreakTime < 3000) {
                if (!this.transferWaitStart) this.transferWaitStart = Date.now();
                this.status = this.STATES.WAITING_TRANSFER;
                return;
            }

            this.transferWaitStart = 0;
            this.status = this.STATES.SCANNING;
            return;
        }

        // === STATE: Active target found ===
        this.transferWaitStart = 0;

        // Check if it's blacklisted
        if (this.isBlacklisted(active.x, active.y, active.z)) {
            this.status = this.STATES.SCANNING;
            return;
        }

        // If within reach, harvest directly
        if (this.isBlockInReach(active)) {
            this.status = this.STATES.HARVESTING;
            this.lastTarget = { x: active.x, y: active.y, z: active.z };

            if (this.harvestMode === 'Nuker') {
                this.nukeTarget(active, token);
            } else {
                this.clickTarget(active, token);
            }
            return;
        }

        // Too far — pathfind to the active berberis
        this.lastTarget = { x: active.x, y: active.y, z: active.z };
        this.startPathToTarget(active, token);
    }

    // ─── Pathing ─────────────────────────────────────────────────

    cancelCurrentPathing() {
        this.pathRequestId++;
        this.pathRequestActive = false;
        Pathfinder.resetPath();
    }

    startPathToTarget(target, token) {
        if (this.isPathGoalReached(target)) {
            // Already close enough, skip pathing
            return;
        }

        const requestId = ++this.pathRequestId;
        this.pathRequestActive = true;
        this.status = this.STATES.PATHING;

        // Path to the block below the berberis (stand ON it)
        const goal = [[target.x, target.y - 1, target.z]];

        Pathfinder.resetPath();
        Pathfinder.findPath(goal, (success) => {
            if (!this.enabled || token !== this.loopToken) return;
            if (requestId !== this.pathRequestId) return;

            this.pathRequestActive = false;
            this.pathsCompleted++;

            if (!success) {
                this.status = 'Path Failed';
                // Blacklist briefly so we don't spam failed paths
                this.blacklist(target.x, target.y, target.z, 5000);
                return;
            }

            // After arriving, try to harvest if still active
            const currentActive = getActiveBerberis();
            if (currentActive && currentActive.x === target.x && currentActive.y === target.y && currentActive.z === target.z) {
                if (this.isBlockInReach(currentActive)) {
                    this.status = this.STATES.HARVESTING;
                    if (this.harvestMode === 'Nuker') {
                        this.nukeTarget(currentActive, token);
                    } else {
                        this.clickTarget(currentActive, token);
                    }
                    return;
                }
            }

            this.status = this.STATES.SCANNING;
        });
    }

    // ─── Click Harvesting ────────────────────────────────────────

    clickTarget(target, token) {
        if (!this.enabled || token !== this.loopToken) return;

        const eye = this.getPlayerEye();
        if (!eye) return;

        const point = this.getAimPoint(target, eye);
        if (!point) {
            this.blacklist(target.x, target.y, target.z);
            return;
        }

        this.harvestRequestActive = true;
        this.retryCount = 0;
        this.clickWithRetry(target, point, token);
    }

    clickWithRetry(target, point, token) {
        if (!this.enabled || token !== this.loopToken) {
            this.harvestRequestActive = false;
            return;
        }

        Rotations.rotateToVector(point);
        Rotations.onEndRotation(() => {
            if (!this.enabled || token !== this.loopToken) {
                this.harvestRequestActive = false;
                return;
            }

            // Re-check if block still exists
            if (!isWiltedBerberisBlock(target.x, target.y, target.z)) {
                this.harvestRequestActive = false;
                this.totalHarvested++;
                this.lastBreakTime = Date.now();
                this.lastTarget = { x: target.x, y: target.y, z: target.z };
                return;
            }

            const refreshedEye = this.getPlayerEye();
            const refreshedPoint = this.getAimPoint(target, refreshedEye);

            if (refreshedPoint && this.isPointInReach(refreshedPoint, refreshedEye)) {
                Keybind.leftClick();
                this.retryCount++;

                // Check if block broke
                if (!isWiltedBerberisBlock(target.x, target.y, target.z)) {
                    this.harvestRequestActive = false;
                    this.totalHarvested++;
                    this.lastBreakTime = Date.now();
                    return;
                }

                // Retry if we haven't exceeded max retries
                if (this.retryCount < MAX_TARGET_CLICK_RETRIES) {
                    this.clickWithRetry(target, refreshedPoint, token);
                    return;
                }
            }

            // Failed to break — blacklist and move on
            this.harvestRequestActive = false;
            this.blacklist(target.x, target.y, target.z);
        });
    }

    // ─── Nuker Harvesting ────────────────────────────────────────

    nukeTarget(target, token) {
        if (!this.enabled || token !== this.loopToken) return;
        if (!isWiltedBerberisBlock(target.x, target.y, target.z)) return;

        NukerUtils.nukeQueueAdd([target.x, target.y, target.z], 1);
        this.totalHarvested++;
        this.lastBreakTime = Date.now();
        this.lastTarget = { x: target.x, y: target.y, z: target.z };
        this.status = this.STATES.WAITING_TRANSFER;
    }

    // ─── Utility ─────────────────────────────────────────────────

    getPlayerEye() {
        return Player.getPlayer()?.getEyePos?.() || null;
    }

    isBlockInReach(target) {
        const eye = this.getPlayerEye();
        if (!eye) return false;

        // Distance to nearest point on the block's bounding box
        const nearestX = Math.max(target.x, Math.min(eye.x, target.x + 1));
        const nearestY = Math.max(target.y, Math.min(eye.y, target.y + 1));
        const nearestZ = Math.max(target.z, Math.min(eye.z, target.z + 1));

        const dx = nearestX - eye.x;
        const dy = nearestY - eye.y;
        const dz = nearestZ - eye.z;
        return Math.hypot(dx, dy, dz) <= MAX_REACH;
    }

    isPointInReach(point, eye = this.getPlayerEye()) {
        if (!eye || !point) return false;
        const x = point.x ?? point[0];
        const y = point.y ?? point[1];
        const z = point.z ?? point[2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
        return Math.hypot(x - eye.x, y - eye.y, z - eye.z) <= MAX_REACH;
    }

    getAimPoint(target, eye = this.getPlayerEye()) {
        if (!eye) return null;
        if (!isWiltedBerberisBlock(target.x, target.y, target.z)) return null;

        for (const offset of BERBERIS_AIM_OFFSETS) {
            const point = {
                x: target.x + offset[0],
                y: target.y + offset[1],
                z: target.z + offset[2],
            };

            if (!this.isPointInReach(point, eye)) continue;
            if (!Raytrace.isLineClear(eye.x, eye.y, eye.z, point.x, point.y, point.z, target.x, target.y, target.z)) continue;

            return point;
        }

        // Fallback: use Raytrace to find any visible point on the block
        const fallback = Raytrace.getVisiblePoint(target.x, target.y, target.z, true);
        if (!fallback) return null;

        const point = { x: fallback[0], y: fallback[1], z: fallback[2] };
        if (!this.isPointInReach(point, eye)) return null;
        return point;
    }

    isPathGoalReached(target) {
        const player = Player.getPlayer();
        if (!player || !target) return false;

        const goalX = target.x;
        const goalY = target.y - 1;
        const goalZ = target.z;

        const dx = Player.getX() - goalX;
        const dy = Player.getY() - goalY;
        const dz = Player.getZ() - goalZ;

        const horizontalDistSq = dx * dx + dz * dz;
        if (horizontalDistSq > 2.5 * 2.5) return false;
        if (dy < -0.1 || dy > 5.5) return false;

        return player.isOnGround();
    }

    // ─── Blacklist ───────────────────────────────────────────────

    blacklist(x, y, z, durationMs = AIM_FAIL_BLACKLIST_MS) {
        const key = `${Math.floor(x)}:${Math.floor(y)}:${Math.floor(z)}`;
        this.blacklistedPositions.set(key, Date.now() + durationMs);
    }

    isBlacklisted(x, y, z) {
        const key = `${Math.floor(x)}:${Math.floor(y)}:${Math.floor(z)}`;
        const expiresAt = this.blacklistedPositions.get(key);
        if (!expiresAt) return false;
        if (expiresAt <= Date.now()) {
            this.blacklistedPositions.delete(key);
            return false;
        }
        return true;
    }

    cleanupBlacklist() {
        const now = Date.now();
        for (const [key, expiresAt] of this.blacklistedPositions.entries()) {
            if (expiresAt <= now) this.blacklistedPositions.delete(key);
        }
    }
}

new WiltedBerberisMacro();
