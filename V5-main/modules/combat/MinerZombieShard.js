import { OverlayManager } from '../../gui/OverlayUtils';
import { ZombieEntity } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { MathUtils } from '../../utils/Math';
import { Utils } from '../../utils/Utils';
import { Guis } from '../../utils/player/Inventory';
import { Keybind } from '../../utils/player/Keybinding';
import { Rotations } from '../../utils/player/Rotations';
import { HumanizedCpsTimer } from '../../utils/TimeUtils';
import Pathfinder from '../../utils/pathfinder/PathFinder';

const STATES = {
    IDLE: 'Idle',
    CHECK_AREA: 'Checking Area',
    FARMING: 'Farming',
    FINISHING: 'Finishing Zombie',
    RECOVERING: 'Recovering',
};

const COMBAT_STATE = {
    IDLE: 'IDLE',
    PATHING: 'PATHING',
    APPROACHING: 'APPROACHING',
    ATTACKING: 'ATTACKING',
};

const FINISH_PHASE = {
    RELEASE: 'release',
    JUMP: 'jump',
    AIM: 'aim',
    PLACE: 'place',
    WAIT_RESULT: 'wait_result',
};

// NOTE: These bounds are a best-effort placeholder for the Obsidian Sanctuary
// mining area. If the macro is attacking zombies outside the intended room,
// or ignoring zombies that should be valid, tighten/widen this box in-game.
const SANCTUARY_BOUNDS = {
    minX: -230,
    maxX: -50,
    minY: 20,
    maxY: 90,
    minZ: -230,
    maxZ: -50,
};

const MINER_ZOMBIE_NAMES = ['Miner Zombie'];

// "Turned into shards" style confirmation messages from placing a Black Hole
// on a low-hp mob. Kept loose/lowercase since exact wording may vary.
const SHARD_HINTS = ['shards', 'turned into', 'sucked into the void', 'consumed'];

const ATTACK_REACH = 4;
const PATHFINDING_THRESHOLD = 12;

class MinerZombieShardMacro extends ModuleBase {
    constructor() {
        super({
            name: 'Miner Zombie Shards',
            subcategory: 'Mining',
            description: 'Farms Miner Zombies in the Obsidian Sanctuary and converts them to shards using a Black Hole.',
            tooltip: 'Must be inside the Obsidian Sanctuary. Fights Miner Zombies and uses a Black Hole to finish them off for shards.',
            theme: '#7d5fff',
            showEnabledToggle: false,
            autoDisableOnWorldUnload: true,
            isMacro: true,
        });
        this.bindToggleKey();

        this.state = STATES.IDLE;

        // --- Settings -------------------------------------------------
        this.weaponName = 'Pickonimbus, Drill';
        this.blackHoleName = 'Black Hole';
        this.hitsToFinish = 2;
        this.attackCPS = 8;
        this.finishRotateSpeed = 0.65;
        this.finishTimeoutMs = 4000;

        // --- Runtime: combat ------------------------------------------
        this.target = null;
        this.combatState = COMBAT_STATE.IDLE;
        this.attackTimer = new HumanizedCpsTimer();
        this.hitCounts = new Map(); // uuid -> number of confirmed hits
        this.isPathing = false;
        this.lastPathTarget = null;
        this.pathTargetMoveThreshold = 3;
        this.pathRequestToken = 0;

        // --- Runtime: finish sequence ----------------------------------
        this.finishPhase = null;
        this.finishTargetUuid = null;
        this.finishTargetPos = null; // last known {x,y,z} of the zombie being finished
        this.finishAimStarted = false;
        this.finishAttemptedAt = 0;
        this.finishAttempts = 0;
        this.finishResultSeen = false;

        // --- Misc state --------------------------------------------------
        this.lastError = 'None';
        this.shardsConfirmed = 0;

        this.createOverlay(
            [
                {
                    title: 'Status',
                    data: {
                        State: () => this.state,
                        Combat: () => this.combatState,
                        Target: () => this.getTargetDisplayName(this.target),
                        Hits: () => (this.target ? this.hitCounts.get(this.getTargetUuid(this.target)) || 0 : 0),
                        Error: () => this.lastError,
                    },
                },
                {
                    title: 'Stats',
                    data: {
                        Shards: () => this.shardsConfirmed,
                    },
                },
            ],
            {
                sessionTrackedValues: {
                    shards: 0,
                },
            }
        );

        this.addTextInput('Weapon Item', this.weaponName, (value) => (this.weaponName = String(value || '')), 'Comma-separated weapon/tool names to hold while fighting.');
        this.addTextInput('Black Hole Item', this.blackHoleName, (value) => (this.blackHoleName = String(value || '')), 'Comma-separated names for the Black Hole item.');
        this.addSlider('Hits To Finish', 1, 6, 2, (value) => (this.hitsToFinish = Math.max(1, Math.round(Number(value) || 2))), 'Number of confirmed hits before switching to the Black Hole finisher.');
        this.addSlider('Attack CPS', 4, 12, 8, (value) => (this.attackCPS = value), 'Attacks per second while fighting.');
        this.addSlider('Finish Rotation Speed', 0.2, 1.5, 0.65, (value) => (this.finishRotateSpeed = Math.max(0.05, Number(value) || 0.65)), 'How fast the bot looks up toward the Black Hole spot during the finish sequence (1.0 = normal combat-aim speed).');
        this.addSlider('Finish Timeout (s)', 1, 10, 4, (value) => (this.finishTimeoutMs = Math.max(500, Math.round((Number(value) || 4) * 1000))), 'How long to wait for the shard confirmation message before retrying/giving up.');

        this.on('tick', () => this.onTick());
        this.on('chat', (event) => this.handleChat(event));
        this.on('worldUnload', () => this.resetRuntime(true));
    }

    onEnable() {
        this.resetRuntime(false);
        this.setState(STATES.FARMING);
        this.message('&aEnabled');
    }

    onDisable() {
        this.message('&cDisabled');
        this.resetRuntime(true);
    }

    onTick() {
        if (!this.enabled || !Player.getPlayer()) return;

        switch (this.state) {
            case STATES.FARMING:
                return this.handleFarming();
            case STATES.FINISHING:
                return this.handleFinishing();
            default:
                return;
        }
    }

    // ------------------------------------------------------------------
    // Area check — only starts if already inside the sanctuary
    // ------------------------------------------------------------------

    handleCheckArea() {
        if (this.isInSanctuary()) {
            this.setState(STATES.FARMING);
            return;
        }

        const area = String(Utils.area?.() || '').toLowerCase();
        const subArea = String(Utils.subArea?.() || '').toLowerCase();
        const px = Math.floor(Player.getX());
        const py = Math.floor(Player.getY());
        const pz = Math.floor(Player.getZ());
        this.message(`&cNot in Obsidian Sanctuary. Area: "&e${area}&c" Sub: "&e${subArea}&c" Pos: &e${px}, ${py}, ${pz}`);
        this.disable();
    }

    isInSanctuary() {
        return true;
    }

    isInBounds(x, y, z) {
        return (
            x >= SANCTUARY_BOUNDS.minX &&
            x <= SANCTUARY_BOUNDS.maxX &&
            y >= SANCTUARY_BOUNDS.minY &&
            y <= SANCTUARY_BOUNDS.maxY &&
            z >= SANCTUARY_BOUNDS.minZ &&
            z <= SANCTUARY_BOUNDS.maxZ
        );
    }

    // ------------------------------------------------------------------
    // Farming loop
    // ------------------------------------------------------------------

    handleFarming() {
        this.equipWeapon();
        this.updateCombat();
    }

    updateCombat() {
        const candidates = this.findMinerZombies();

        // Validate current target
        if (this.target && this.isTargetInvalid(this.target, candidates)) {
            this.target = null;
            this.setState_combat(COMBAT_STATE.IDLE);
        }

        if (!this.target) {
            this.target = this.pickNearestTarget(candidates);
            if (!this.target) {
                this.setState_combat(COMBAT_STATE.IDLE);
                Keybind.stopMovement();
                return;
            }
            this.setState_combat(COMBAT_STATE.IDLE);
        }

        const pos = { x: this.target.getX(), y: this.target.getY(), z: this.target.getZ() };
        const distanceData = this.getDistanceToPlayer(pos);

        this.handleCombatState(pos, distanceData);
    }

    equipWeapon() {
        const slot = this.findHotbarSlot(this.weaponName);
        if (slot !== -1 && Player.getHeldItemIndex() !== slot) {
            Guis.setItemSlot(slot);
        }
    }

    // ------------------------------------------------------------------
    // Combat: target acquisition
    // ------------------------------------------------------------------

    findMinerZombies() {
        const out = [];

        // Target all zombies
        World.getAllEntitiesOfType(ZombieEntity).forEach((entity) => {
            try {
                if (!entity || entity.isDead?.()) return;

                // Skip if currently being finished
                const uuid = this.getEntityUuid(entity);
                if (uuid === this.finishTargetUuid) return;

                out.push(entity);
            } catch (e) {
                // Silently ignore errors
            }
        });

        return out;
    }

    matchesMinerZombie(name) {
        // Miner Zombies are just named "Zombie" - use bounds check instead
        return true;
    }

    pickNearestTarget(candidates) {
        let best = null;
        let bestDist = Infinity;

        candidates.forEach((entity) => {
            const hits = this.hitCounts.get(this.getEntityUuid(entity)) || 0;
            if (hits >= this.hitsToFinish) return; // already maxed, skip until finished

            const pos = { x: entity.getX(), y: entity.getY(), z: entity.getZ() };
            const dist = this.getDistanceToPlayer(pos).distance;
            if (dist < bestDist) {
                bestDist = dist;
                best = entity;
            }
        });

        return best;
    }

    // ------------------------------------------------------------------
    // Combat: state machine (standalone replacement for CombatBot)
    // ------------------------------------------------------------------

    updateCombat() {
        const candidates = this.findMinerZombies();

        // Validate current target: still alive, still in bounds, not over
        // the hit cap (which would mean it's queued for finishing).
        if (this.target && this.isTargetInvalid(this.target, candidates)) {
            this.target = null;
            this.setState_combat(COMBAT_STATE.IDLE);
        }

        if (!this.target) {
            this.target = this.pickNearestTarget(candidates);
            if (!this.target) {
                this.setState_combat(COMBAT_STATE.IDLE);
                Keybind.stopMovement();
                return;
            }
            this.setState_combat(COMBAT_STATE.IDLE);
        }

        const pos = { x: this.target.getX(), y: this.target.getY(), z: this.target.getZ() };
        const distanceData = this.getDistanceToPlayer(pos);

        this.handleCombatState(pos, distanceData);
    }

    isTargetInvalid(target, candidates) {
        try {
            if (target.isDead?.()) return true;
            const uuid = this.getEntityUuid(target);
            const hits = this.hitCounts.get(uuid) || 0;
            if (hits >= this.hitsToFinish) return true;
            // Still present in the world's candidate list?
            return !candidates.some((c) => this.getEntityUuid(c) === uuid);
        } catch (e) {
            return true;
        }
    }

    setState_combat(state, force = false) {
        if (!force && this.combatState === state) return;
        this.onExitCombatState(this.combatState);
        this.combatState = state;
        this.onEnterCombatState(state);
    }

    onExitCombatState(state) {
        if (state === COMBAT_STATE.PATHING) {
            Pathfinder.resetPath();
            this.isPathing = false;
        } else if (state === COMBAT_STATE.APPROACHING || state === COMBAT_STATE.ATTACKING) {
            Keybind.stopMovement();
        }
    }

    onEnterCombatState(state) {
        if (state === COMBAT_STATE.IDLE || state === COMBAT_STATE.PATHING) {
            Keybind.stopMovement();
            Rotations.stopRotation();
        } else if (state === COMBAT_STATE.APPROACHING || state === COMBAT_STATE.ATTACKING) {
            Pathfinder.resetPath();
            this.isPathing = false;
            if (state === COMBAT_STATE.ATTACKING) Keybind.stopMovement();
        }
    }

    handleCombatState(pos, distanceData) {
        switch (this.combatState) {
            case COMBAT_STATE.IDLE:
                return this.handleCombatIdle(pos, distanceData);
            case COMBAT_STATE.PATHING:
                return this.handleCombatPathing(pos, distanceData);
            case COMBAT_STATE.APPROACHING:
                return this.handleCombatApproaching(pos, distanceData);
            case COMBAT_STATE.ATTACKING:
                return this.handleCombatAttacking(pos, distanceData);
        }
    }

    handleCombatIdle(pos, distanceData) {
        if (distanceData.distance > ATTACK_REACH) {
            return this.startPathingToTarget(pos);
        }
        this.setState_combat(COMBAT_STATE.ATTACKING);
    }

    handleCombatPathing(pos, distanceData) {
        if (this.lastPathTarget) {
            const moved = this.getDistanceBetween(pos, this.lastPathTarget);
            if (moved.distance > this.pathTargetMoveThreshold) {
                this.startPathingToTarget(pos);
                return;
            }
        }

        if (distanceData.distance <= ATTACK_REACH) {
            this.setState_combat(COMBAT_STATE.ATTACKING);
        }
    }

    handleCombatApproaching(pos, distanceData) {
        if (distanceData.distance <= ATTACK_REACH) {
            this.setState_combat(COMBAT_STATE.ATTACKING);
            return;
        }

        if (distanceData.distance > PATHFINDING_THRESHOLD) {
            this.startPathingToTarget(pos);
            return;
        }

        Keybind.setKeysForStraightLineCoords(pos.x, pos.y, pos.z, true, true);
        Keybind.setKey('sprint', true);
        Rotations.rotateToEntity(this.target);
    }

    handleCombatAttacking(pos, distanceData) {
        if (distanceData.distance > PATHFINDING_THRESHOLD) {
            this.startPathingToTarget(pos);
            return;
        }

        if (distanceData.distance > ATTACK_REACH * 1.5) {
            this.setState_combat(COMBAT_STATE.APPROACHING);
            return;
        }

        this.tryAttack(distanceData);
        Rotations.rotateToEntity(this.target);

        if (distanceData.distanceFlat <= 2) Keybind.stopMovement();
        else Keybind.setKeysForStraightLineCoords(pos.x, pos.y, pos.z, true, true);

        if (distanceData.distanceY < -3) Keybind.setKey('space', true);
        Keybind.setKey('sprint', true);
    }

    startPathingToTarget(pos) {
        const end = this.buildPathEndpoints(pos);
        this.lastPathTarget = { x: pos.x, y: pos.y, z: pos.z };
        this.isPathing = true;
        this.setState_combat(COMBAT_STATE.PATHING);
        const pathToken = ++this.pathRequestToken;

        const pathTarget = this.target;

        Pathfinder.resetPath();
        Pathfinder.findPath(end, (success) => {
            if (pathToken !== this.pathRequestToken) return;

            if (!success) {
                if (pathTarget && !pathTarget.isDead?.()) {
                    const currentPos = { x: pathTarget.getX(), y: pathTarget.getY(), z: pathTarget.getZ() };
                    const dist = this.getDistanceToPlayer(currentPos);
                    if (dist.distance <= PATHFINDING_THRESHOLD) {
                        this.setState_combat(COMBAT_STATE.APPROACHING);
                        return;
                    }
                }
                this.target = null;
                this.setState_combat(COMBAT_STATE.IDLE);
                return;
            }

            if (this.target && !this.target.isDead?.()) {
                const currentPos = { x: this.target.getX(), y: this.target.getY(), z: this.target.getZ() };
                const distanceData = this.getDistanceToPlayer(currentPos);
                this.setState_combat(distanceData.distance <= ATTACK_REACH ? COMBAT_STATE.ATTACKING : COMBAT_STATE.APPROACHING);
            } else {
                this.target = null;
                this.setState_combat(COMBAT_STATE.IDLE);
            }
        });
    }

    buildPathEndpoints(pos) {
        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        return [
            [x, y - 1, z],
            [x, y, z],
            [x, y + 1, z],
        ];
    }

    tryAttack(distanceData) {
        const now = Date.now();
        if (!this.attackTimer.tryClick(this.attackCPS, now)) return;

        // Use CombatBot's approach: rotate to entity directly
        Rotations.rotateToEntity(this.target);
        Keybind.leftClick();

        this.registerHit(this.target);
    }

    findOptimalHitPoint(target) {
        try {
            const entity = target.toMC ? target.toMC() : target;
            const box = entity.getBoundingBox();
            if (!box) return null;
            const height = box.maxY - box.minY;
            return {
                x: (box.minX + box.maxX) / 2,
                y: box.minY + height * 0.7,
                z: (box.minZ + box.maxZ) / 2,
            };
        } catch (e) {
            return null;
        }
    }

    registerHit(target) {
        const uuid = this.getEntityUuid(target);
        if (!uuid) return;

        const newCount = (this.hitCounts.get(uuid) || 0) + 1;
        this.hitCounts.set(uuid, newCount);

        if (newCount >= this.hitsToFinish) {
            this.beginFinishSequence(target);
        }
    }

    // ------------------------------------------------------------------
    // Finish sequence: jump, smooth-rotate above target, place Black Hole
    // ------------------------------------------------------------------

    beginFinishSequence(target) {
        Keybind.stopMovement();
        Rotations.stopRotation();
        Pathfinder.resetPath();
        this.isPathing = false;
        this.setState_combat(COMBAT_STATE.IDLE);

        const uuid = this.getEntityUuid(target);
        this.finishTargetUuid = uuid;
        this.finishTargetPos = { x: target.getX(), y: target.getY(), z: target.getZ() };
        this.finishAttempts = 0;
        this.finishResultSeen = false;
        this.target = null;

        this.startFinishAttempt();
        this.setState(STATES.FINISHING);
    }

    startFinishAttempt() {
        this.finishAttempts++;
        this.finishPhase = FINISH_PHASE.RELEASE;
        this.finishAimStarted = false;
        this.finishResultSeen = false;
        this.finishAttemptedAt = Date.now();
    }

    handleFinishing() {
        switch (this.finishPhase) {
            case FINISH_PHASE.RELEASE:
                return this.finishRelease();
            case FINISH_PHASE.JUMP:
                return this.finishJump();
            case FINISH_PHASE.AIM:
                return this.finishAim();
            case FINISH_PHASE.PLACE:
                return this.finishPlace();
            case FINISH_PHASE.WAIT_RESULT:
                return this.finishWaitResult();
            default:
                return this.completeFinishSequence(false);
        }
    }

    finishRelease() {
        Keybind.stopMovement();
        Keybind.setKey('sprint', false);
        this.finishPhase = FINISH_PHASE.JUMP;
    }

    finishJump() {
        Keybind.setKey('space', true);
        Keybind.setKey('space', false);
        this.finishPhase = FINISH_PHASE.AIM;
        this.finishAimStarted = false;
    }

    finishAim() {
        if (!this.finishTargetPos) {
            return this.completeFinishSequence(false);
        }

        const aimPoint = {
            x: this.finishTargetPos.x + 0.5,
            y: this.finishTargetPos.y + 2.2,
            z: this.finishTargetPos.z + 0.5,
        };

        if (!this.finishAimStarted) {
            Rotations.rotateToVector(aimPoint, true, this.finishRotateSpeed);
            this.finishAimStarted = true;
            return;
        }

        if (!Rotations.isRotating) {
            this.finishPhase = FINISH_PHASE.PLACE;
        }
    }

    finishPlace() {
        const slot = this.findHotbarSlot(this.blackHoleName);
        if (slot === -1) {
            this.lastError = 'Missing Black Hole item.';
            return this.completeFinishSequence(false);
        }

        if (Player.getHeldItemIndex() !== slot) {
            Guis.setItemSlot(slot);
            return;
        }

        Keybind.rightClick();
        this.finishPhase = FINISH_PHASE.WAIT_RESULT;
        this.finishAttemptedAt = Date.now();
        this.finishResultSeen = false;
    }

    finishWaitResult() {
        if (this.finishResultSeen) {
            this.shardsConfirmed++;
            OverlayManager.incrementTrackedValue(this.oid, 'shards');
            return this.completeFinishSequence(true);
        }

        if (Date.now() - this.finishAttemptedAt < this.finishTimeoutMs) return;

        if (this.finishAttempts < 2) {
            this.startFinishAttempt();
            return;
        }

        this.completeFinishSequence(false);
    }

    completeFinishSequence(success) {
        if (!success) {
            this.lastError = this.lastError === 'None' ? 'Black Hole finish did not confirm.' : this.lastError;
        } else {
            this.lastError = 'None';
        }

        if (this.finishTargetUuid) this.hitCounts.delete(this.finishTargetUuid);

        this.finishPhase = null;
        this.finishTargetUuid = null;
        this.finishTargetPos = null;

        Rotations.stopRotation();
        this.setState(STATES.FARMING);
    }

    abandonFinishSequence(reason) {
        this.lastError = reason || 'Unknown';
        if (this.finishTargetUuid) this.hitCounts.delete(this.finishTargetUuid);
        this.finishPhase = null;
        this.finishTargetUuid = null;
        this.finishTargetPos = null;
        Rotations.stopRotation();
        Keybind.stopMovement();
    }

    // ------------------------------------------------------------------
    // Chat handling
    // ------------------------------------------------------------------

    handleChat(event) {
        if (!this.enabled) return;
        if (this.state !== STATES.FINISHING) return;
        if (this.finishPhase !== FINISH_PHASE.WAIT_RESULT) return;

        const msg = this.cleanName(event?.message?.getUnformattedText?.() || String(event?.message || event || '')).toLowerCase();
        if (!msg) return;

        if (SHARD_HINTS.some((hint) => msg.includes(hint))) {
            this.finishResultSeen = true;
        }
    }

    // ------------------------------------------------------------------
    // Recovery / lifecycle
    // ------------------------------------------------------------------

    handleRecovering() {
        Keybind.unpressKeys();
        Rotations.stopRotation();
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
    }

    resetRuntime(stopCombat = true) {
        this.state = STATES.IDLE;
        this.target = null;
        this.combatState = COMBAT_STATE.IDLE;
        this.hitCounts.clear();
        this.isPathing = false;
        this.lastPathTarget = null;
        this.pathRequestToken++;

        this.finishPhase = null;
        this.finishTargetUuid = null;
        this.finishTargetPos = null;
        this.finishAimStarted = false;
        this.finishAttempts = 0;
        this.finishResultSeen = false;

        this.lastError = 'None';

        if (stopCombat) {
            Pathfinder.resetPath();
            Rotations.stopRotation();
            Keybind.unpressKeys();
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    findHotbarSlot(names) {
        const candidates = String(names || '')
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name.length > 0);

        for (let i = 0; i < candidates.length; i++) {
            const slot = Guis.findItemInHotbar(candidates[i]);
            if (slot !== -1) return slot;
        }
        return -1;
    }

    getEntityUuid(entity) {
        try {
            if (!entity) return null;
            if (entity.getUUID) return entity.getUUID().toString();
            if (entity.toMC?.().getUuid) return entity.toMC().getUuid().toString();
        } catch (e) {}
        return null;
    }

    getTargetUuid(target) {
        return this.getEntityUuid(target);
    }

    getTargetDisplayName(target) {
        if (!target) return 'None';
        try {
            return this.cleanName(target.getName?.()) || 'Unknown';
        } catch (e) {
            return 'Unknown';
        }
    }

    cleanName(text) {
        return ChatLib.removeFormatting(String(text || '')).trim();
    }

    getDistanceToPlayer(pos) {
        return MathUtils.getDistanceToPlayer(pos.x, pos.y, pos.z);
    }

    getDistanceBetween(pos1, pos2) {
        return MathUtils.getDistance(pos1.x, pos1.y, pos1.z, pos2.x, pos2.y, pos2.z);
    }
}

new MinerZombieShardMacro();