import { OverlayManager } from '../../gui/OverlayUtils';
import { ArmorStandEntity, ZombieEntity } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { manager } from '../../utils/SkyblockEvents';
import { Utils } from '../../utils/Utils';
import { Guis } from '../../utils/player/Inventory';
import { Keybind } from '../../utils/player/Keybinding';
import { CombatBot } from '../combat/CombatBot';

const STATES = {
    IDLE: 'Idle',
    CHECK_AREA: 'Checking Area',
    START_QUEST: 'Starting Quest',
    TRAVEL_CRYPTS: 'Traveling to Crypts',
    FARMING: 'Farming',
    BOSS_ACTIVE: 'Boss Active',
    CLAIMING: 'Claiming',
    RECOVERING: 'Recovering',
};

const SUPPORT_ACTION = {
    IDLE: 'idle',
    USE: 'use',
    RETURN: 'return',
};

const CRYPT_CENTER = { x: -162, y: 61, z: -100 };
const CRYPT_BOUNDS = {
    minX: -230,
    maxX: -70,
    minY: 30,
    maxY: 90,
    minZ: -175,
    maxZ: -25,
};

const NAMETAG_BODY_RADIUS = 3.5;

const FILLER_NAMES = ['Crypt Ghoul', 'Golden Ghoul'];
const MINIBOSS_NAMES = ['Revenant Sycophant', 'Revenant Champion', 'Deformed Revenant', 'Atoned Champion'];
const BOSS_NAMES = ['Revenant Horror', 'Atoned Horror'];
const ALL_TARGET_NAMES = [...FILLER_NAMES, ...MINIBOSS_NAMES, ...BOSS_NAMES];

const TARGET_CONFIG = {
    names: ALL_TARGET_NAMES,
    checkVisibility: true,
    boundaryCheck: (x, y, z) => x >= CRYPT_BOUNDS.minX && x <= CRYPT_BOUNDS.maxX && y >= CRYPT_BOUNDS.minY && y <= CRYPT_BOUNDS.maxY && z >= CRYPT_BOUNDS.minZ && z <= CRYPT_BOUNDS.maxZ,
};

const QUEST_START_HINTS = ['slayer quest started', 'zombie slayer', 'revenant horror'];
const QUEST_COMPLETE_HINTS = ['slayer quest complete', 'boss slain', 'revenant horror down', 'completed your slayer quest'];
const BOSS_SPAWN_HINTS = ['slay the boss', 'revenant horror spawned', 'your revenant horror'];

class RevenantSlayer extends ModuleBase {
    constructor() {
        super({
            name: 'Revenant Slayer',
            subcategory: 'Combat',
            description: 'Runs Zombie Slayer in the Hub Crypts using Combat Bot.',
            tooltip: 'Starts Zombie Slayer quests and farms Revenant targets in the Hub Crypts.',
            theme: '#c74d4d',
            showEnabledToggle: false,
            autoDisableOnWorldUnload: true,
            isMacro: true,
        });
        this.bindToggleKey();

        this.state = STATES.IDLE;
        this.slayerTier = 4;
        this.phoneName = 'Maddox Batphone, Abiphone';
        this.weaponName = 'Reaper Falchion, Revenant Falchion, Aspect of the Dragons';
        this.healName = 'Wand, Florid';
        this.deployableName = 'Power Orb, Flare';
        this.mobilityName = 'Aspect of the Void, Aspect of the End';
        this.autoHeal = true;
        this.autoDeploy = true;
        this.useWarpCrypts = true;
        this.healthThreshold = 55;

        this.questActive = false;
        this.autoSlayerDetected = false;
        this.lastQuestSeenAt = 0;
        this.lastBossSeenAt = 0;
        this.lastActionAt = 0;
        this.lastWarpAt = 0;
        this.lastHealAt = 0;
        this.lastDeployAt = 0;
        this.lastError = 'None';
        this.targetCount = 0;

        this.supportPhase = SUPPORT_ACTION.IDLE;
        this.supportFeature = null;
        this.supportSlot = -1;
        this.swapBackSlot = -1;

        this.createOverlay(
            [
                {
                    title: 'Status',
                    data: {
                        State: () => this.state,
                        Quest: () => (this.questActive ? 'Zombie Slayer' : 'None'),
                        Tier: () => `T${this.slayerTier}`,
                        Target: () => CombatBot.getTargetDisplayName?.(CombatBot.target) || 'None',
                        Targets: () => this.targetCount,
                        Error: () => this.lastError,
                    },
                },
                {
                    title: 'Stats',
                    data: {
                        Bosses: () => OverlayManager.getTrackedValue(this.oid, 'bosses', 0),
                        'Bosses/hr': () => this.getBossesPerHour(),
                    },
                },
            ],
            {
                sessionTrackedValues: {
                    bosses: 0,
                },
            }
        );

        this.addSlider('Slayer Tier', 1, 5, 4, (value) => (this.slayerTier = Math.round(Number(value) || 4)), 'Zombie Slayer tier to start.');
        this.addTextInput('Maddox Phone Item', this.phoneName, (value) => (this.phoneName = String(value || '')), 'Comma-separated item names that open Maddox.');
        this.addTextInput('Weapon Item', this.weaponName, (value) => (this.weaponName = String(value || '')), 'Comma-separated weapon names.');
        this.addTextInput('Heal Item', this.healName, (value) => (this.healName = String(value || '')), 'Comma-separated healing item names.');
        this.addTextInput('Deployable Item', this.deployableName, (value) => (this.deployableName = String(value || '')), 'Comma-separated deployable item names.');
        this.addTextInput('Mobility Item', this.mobilityName, (value) => (this.mobilityName = String(value || '')), 'Comma-separated mobility item names.');
        this.addToggle('Auto Heal', (value) => (this.autoHeal = !!value), 'Use configured heal item below the threshold.', true);
        this.addSlider('Heal Threshold', 5, 95, 55, (value) => (this.healthThreshold = Number(value) || 55), 'Health percent for auto heal.');
        this.addToggle('Auto Deploy', (value) => (this.autoDeploy = !!value), 'Deploy orb/flare when a boss appears.', true);
        this.addToggle('Use Warp Crypts', (value) => (this.useWarpCrypts = !!value), 'Use /warp crypts for travel.', true);

        this.on('tick', () => this.onTick());
        this.on('step', () => this.refreshQuestFromWorld()).setFps(2);
        this.on('worldUnload', () => this.resetRuntime(true));

        this.on('chat', (event) => this.handleChat(event));
        manager.subscribe('death', () => {
            if (this.enabled) this.enterRecovery('Death detected.');
        });
        manager.subscribe('serverchange', () => {
            if (this.enabled) this.enterRecovery('Server changed.');
        });
    }

    onEnable() {
        this.resetRuntime(false);
        this.configureCombatBot();
        this.setState(STATES.CHECK_AREA);
        this.message('&aEnabled');
    }

    onDisable() {
        this.message('&cDisabled');
        this.resetRuntime(true);
    }

    onTick() {
        if (!this.enabled || !Player.getPlayer()) return;

        if (this.progressSupportAction()) return;

        switch (this.state) {
            case STATES.CHECK_AREA:
                return this.handleCheckArea();
            case STATES.TRAVEL_CRYPTS:
                return this.handleTravelCrypts();
            case STATES.START_QUEST:
                return this.handleStartQuest();
            case STATES.FARMING:
            case STATES.BOSS_ACTIVE:
                return this.handleFarming();
            case STATES.CLAIMING:
                return this.handleClaiming();
            case STATES.RECOVERING:
                return this.handleRecovering();
            default:
                return;
        }
    }

    handleCheckArea() {
        if (!this.isInHubArea() || !this.isNearCrypts()) {
            if (this.useWarpCrypts) {
                this.warpCrypts();
                this.setState(STATES.TRAVEL_CRYPTS);
                return;
            }
            this.enterRecovery('Not in Hub Crypts.');
            return;
        }

        this.setState(this.isQuestActive() ? STATES.FARMING : STATES.START_QUEST);
    }

    handleTravelCrypts() {
        if (this.isInHubArea() && this.isNearCrypts()) {
            this.setState(this.isQuestActive() ? STATES.FARMING : STATES.START_QUEST);
            return;
        }

        if (this.useWarpCrypts && Date.now() - this.lastWarpAt > 8000) {
            this.warpCrypts();
        }
    }

    handleStartQuest() {
        this.stopCombatBot();
        if (this.isQuestActive()) {
            this.setState(STATES.FARMING);
            return;
        }

        if (Date.now() - this.lastActionAt < 800) return;
        this.lastActionAt = Date.now();

        const gui = Guis.guiName();
        if (gui) {
            if (this.clickQuestMenu(gui)) return;
            return;
        }

        const phoneSlot = this.findHotbarSlot(this.phoneName);
        if (phoneSlot === -1) {
            this.enterRecovery('Missing Maddox phone item.');
            return;
        }

        Guis.setItemSlot(phoneSlot);
        Keybind.rightClick();
    }

    handleFarming() {
        if (!this.isInHubArea() || !this.isNearCrypts()) {
            this.setState(STATES.CHECK_AREA);
            return;
        }

        if (!this.isQuestActive() && Date.now() - this.lastQuestSeenAt > 5000) {
            this.setState(STATES.START_QUEST);
            return;
        }

        this.equipWeapon();
        this.feedCombatTargets();
        this.handleSupportActions();

        const bossActive = this.isBossActive();
        if (bossActive && this.state !== STATES.BOSS_ACTIVE) this.setState(STATES.BOSS_ACTIVE);
        if (!bossActive && this.state === STATES.BOSS_ACTIVE) this.setState(STATES.FARMING);
    }

    handleClaiming() {
        this.stopCombatBot();
        if (Date.now() - this.lastActionAt < 1500) return;
        this.setState(this.isQuestActive() ? STATES.FARMING : STATES.START_QUEST);
    }

    handleRecovering() {
        this.stopCombatBot();
        Keybind.unpressKeys();
    }

    clickQuestMenu(guiName) {
        const lower = String(guiName || '').toLowerCase();

        if (lower.includes('slayer') || lower.includes('maddox')) {
            return this.clickFirst([
                'Zombie Slayer',
                'Revenant Horror',
                `Revenant Horror ${this.getRomanTier()}`,
                `Tier ${this.getRomanTier()}`,
                `Tier ${this.slayerTier}`,
                'Start',
                'Begin',
                'Confirm',
            ]);
        }

        return this.clickFirst(['Slayer', 'Maddox', 'Start Slayer Quest']);
    }

    clickFirst(names) {
        for (let i = 0; i < names.length; i++) {
            if (Guis.clickItem(names[i], false, 'LEFT', true, false)) return true;
        }
        return false;
    }

    feedCombatTargets() {
        const mobs = this.findRevenantTargets();
        this.targetCount = mobs.length;
        CombatBot.setExternalTargets(mobs);
        this.configureCombatBot();

        if (!CombatBot.enabled) {
            CombatBot.toggle(true, true);
        }
    }

    findRevenantTargets() {
        const targets = [];
        const wrappedZombieIds = new Set();
        CombatBot.findMob(TARGET_CONFIG).forEach((mob) => targets.push(mob));

        this.findNamedZombieTargets().forEach((target) => {
            targets.push(target);
            const uuid = this.getEntityUuid(target);
            if (uuid) wrappedZombieIds.add(uuid);
        });

        World.getAllEntitiesOfType(ZombieEntity).forEach((entity) => {
            try {
                if (entity.isDead()) return;
                if (!TARGET_CONFIG.boundaryCheck(entity.getX(), entity.getY(), entity.getZ())) return;

                const uuid = this.getEntityUuid(entity);
                if (uuid && wrappedZombieIds.has(uuid)) return;

                const name = this.cleanName(entity.getName?.());
                if (name && this.matchesTargetName(name)) {
                    targets.push(entity);
                    return;
                }

                if (!this.isLikelyCryptZombie(entity)) return;
                targets.push(entity);
            } catch (e) {
                console.error('V5 Caught error' + e + e.stack);
            }
        });

        return targets;
    }

    findNamedZombieTargets() {
        const out = [];
        const used = new Set();
        const stands = World.getAllEntitiesOfType(ArmorStandEntity) || [];
        const zombies = World.getAllEntitiesOfType(ZombieEntity) || [];

        stands.forEach((stand) => {
            try {
                const standName = this.cleanName(stand.getName?.());
                if (!this.matchesTargetName(standName)) return;
                if (!TARGET_CONFIG.boundaryCheck(stand.getX(), stand.getY(), stand.getZ())) return;

                const body = this.findNearestZombieBody(stand, zombies, used);
                if (!body) return;

                const uuid = this.getEntityUuid(body);
                if (uuid) used.add(uuid);
                out.push(this.wrapNamedTarget(body, standName));
            } catch (e) {
                console.error('V5 Caught error' + e + e.stack);
            }
        });

        return out;
    }

    findNearestZombieBody(stand, zombies, used) {
        let best = null;
        let bestDistance = Infinity;

        zombies.forEach((zombie) => {
            try {
                if (!zombie || zombie.isDead?.()) return;
                const uuid = this.getEntityUuid(zombie);
                if (uuid && used.has(uuid)) return;
                if (!TARGET_CONFIG.boundaryCheck(zombie.getX(), zombie.getY(), zombie.getZ())) return;

                const dx = zombie.getX() - stand.getX();
                const dy = zombie.getY() - stand.getY();
                const dz = zombie.getZ() - stand.getZ();
                const distance = Math.hypot(dx, dy, dz);
                if (distance > NAMETAG_BODY_RADIUS || distance >= bestDistance) return;

                best = zombie;
                bestDistance = distance;
            } catch (e) {}
        });

        return best;
    }

    wrapNamedTarget(entity, displayName) {
        return {
            name: displayName,
            getName: () => displayName,
            getX: () => entity.getX(),
            getY: () => entity.getY(),
            getZ: () => entity.getZ(),
            getUUID: () => entity.getUUID(),
            isDead: () => entity.isDead(),
            toMC: () => (entity.toMC ? entity.toMC() : entity),
        };
    }

    configureCombatBot() {
        CombatBot.setTargetPriorityRules([
            { names: BOSS_NAMES, priority: 5 },
            { names: MINIBOSS_NAMES, priority: 3 },
            { names: FILLER_NAMES, priority: 1 },
        ]);
    }

    stopCombatBot() {
        CombatBot.setExternalTargets([]);
        CombatBot.clearTargetPriorityRules();
        if (CombatBot.enabled) CombatBot.toggle(false, true);
        this.targetCount = 0;
    }

    handleSupportActions() {
        if (Client.isInGui() && !Client.isInChat()) return;
        if (this.supportPhase !== SUPPORT_ACTION.IDLE) return;

        if (this.autoDeploy && this.isBossActive() && Date.now() - this.lastDeployAt > 30000) {
            const deploySlot = this.findHotbarSlot(this.deployableName);
            if (deploySlot !== -1) {
                this.beginSupportAction('deploy', deploySlot);
                return;
            }
        }

        if (this.autoHeal && Date.now() - this.lastHealAt > 1200 && this.getHealthPercent() <= this.healthThreshold) {
            const healSlot = this.findHotbarSlot(this.healName);
            if (healSlot !== -1) this.beginSupportAction('heal', healSlot);
        }
    }

    beginSupportAction(feature, slot) {
        this.supportFeature = feature;
        this.supportSlot = slot;
        this.swapBackSlot = Player.getHeldItemIndex();
        this.supportPhase = SUPPORT_ACTION.USE;
    }

    progressSupportAction() {
        if (this.supportPhase === SUPPORT_ACTION.IDLE) return false;

        if (this.supportSlot === -1) {
            this.resetSupportAction();
            return false;
        }

        switch (this.supportPhase) {
            case SUPPORT_ACTION.USE:
                if (Player.getHeldItemIndex() !== this.supportSlot) {
                    Guis.setItemSlot(this.supportSlot);
                    return true;
                }
                Keybind.rightClick();
                if (this.supportFeature === 'heal') this.lastHealAt = Date.now();
                if (this.supportFeature === 'deploy') this.lastDeployAt = Date.now();
                this.supportPhase = SUPPORT_ACTION.RETURN;
                return true;
            case SUPPORT_ACTION.RETURN:
                if (this.swapBackSlot !== -1 && Player.getHeldItemIndex() !== this.swapBackSlot) {
                    Guis.setItemSlot(this.swapBackSlot);
                    return true;
                }
                this.resetSupportAction();
                return false;
            default:
                this.resetSupportAction();
                return false;
        }
    }

    resetSupportAction() {
        this.supportPhase = SUPPORT_ACTION.IDLE;
        this.supportFeature = null;
        this.supportSlot = -1;
        this.swapBackSlot = -1;
    }

    equipWeapon() {
        const slot = this.findHotbarSlot(this.weaponName);
        if (slot !== -1 && Player.getHeldItemIndex() !== slot && this.supportPhase === SUPPORT_ACTION.IDLE) {
            Guis.setItemSlot(slot);
        }
    }

    refreshQuestFromWorld() {
        if (!this.enabled) return;

        const text = this.getWorldText().toLowerCase();
        if (text.includes('zombie slayer') || text.includes('revenant horror')) {
            this.questActive = true;
            this.lastQuestSeenAt = Date.now();
        }

        if (text.includes('slay the boss')) {
            this.lastBossSeenAt = Date.now();
        }

        this.detectOwnBossStand();
    }

    detectOwnBossStand() {
        const playerName = String(Player.getName?.() || '').toLowerCase();
        if (!playerName) return;

        const stands = World.getAllEntitiesOfType(ArmorStandEntity);
        for (const stand of stands || []) {
            const standName = this.cleanName(stand.getName?.()).toLowerCase();
            if (!standName.includes('spawned by')) continue;
            if (!standName.includes(playerName)) continue;
            this.lastBossSeenAt = Date.now();
            this.questActive = true;
            this.lastQuestSeenAt = Date.now();
            return;
        }
    }

    handleChat(event) {
        if (!this.enabled) return;
        const msg = this.cleanName(event?.message?.getUnformattedText?.() || String(event?.message || event || '')).toLowerCase();
        if (!msg) return;

        if (QUEST_START_HINTS.some((hint) => msg.includes(hint)) || msg.includes('auto-slayer')) {
            this.questActive = true;
            this.autoSlayerDetected = msg.includes('auto-slayer');
            this.lastQuestSeenAt = Date.now();
            if (this.state === STATES.START_QUEST || this.state === STATES.CLAIMING) this.setState(STATES.FARMING);
        }

        if (BOSS_SPAWN_HINTS.some((hint) => msg.includes(hint))) {
            this.lastBossSeenAt = Date.now();
            this.setState(STATES.BOSS_ACTIVE);
        }

        if (QUEST_COMPLETE_HINTS.some((hint) => msg.includes(hint))) {
            this.questActive = false;
            this.lastActionAt = Date.now();
            OverlayManager.incrementTrackedValue(this.oid, 'bosses');
            this.setState(STATES.CLAIMING);
        }
    }

    isQuestActive() {
        if (this.questActive) return true;
        return Date.now() - this.lastQuestSeenAt < 10000;
    }

    isBossActive() {
        if (Date.now() - this.lastBossSeenAt < 7000) return true;
        return this.findRevenantTargets().some((target) => this.matchesBossName(this.cleanName(target.getName?.())));
    }

    isInHubArea() {
        const area = String(Utils.area?.() || '').toLowerCase();
        return area === 'hub' || area.includes('hub');
    }

    isNearCrypts() {
        return this.isInCryptBounds(Player.getX(), Player.getY(), Player.getZ()) || this.distanceTo(CRYPT_CENTER) < 90;
    }

    isInCryptBounds(x, y, z) {
        return x >= CRYPT_BOUNDS.minX && x <= CRYPT_BOUNDS.maxX && y >= CRYPT_BOUNDS.minY && y <= CRYPT_BOUNDS.maxY && z >= CRYPT_BOUNDS.minZ && z <= CRYPT_BOUNDS.maxZ;
    }

    warpCrypts() {
        this.lastWarpAt = Date.now();
        ChatLib.command('warp crypts');
    }

    enterRecovery(reason) {
        this.lastError = reason || 'Unknown';
        this.setState(STATES.RECOVERING);
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
    }

    resetRuntime(stopCombat = true) {
        if (stopCombat) this.stopCombatBot();
        this.state = STATES.IDLE;
        this.questActive = false;
        this.autoSlayerDetected = false;
        this.lastQuestSeenAt = 0;
        this.lastBossSeenAt = 0;
        this.lastActionAt = 0;
        this.lastWarpAt = 0;
        this.lastHealAt = 0;
        this.lastDeployAt = 0;
        this.lastError = 'None';
        this.targetCount = 0;
        this.resetSupportAction();
        Keybind.unpressKeys();
    }

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

    matchesTargetName(name) {
        const lower = String(name || '').toLowerCase();
        return ALL_TARGET_NAMES.some((targetName) => lower.includes(targetName.toLowerCase()));
    }

    matchesBossName(name) {
        const lower = String(name || '').toLowerCase();
        return BOSS_NAMES.some((targetName) => lower.includes(targetName.toLowerCase()));
    }

    isLikelyCryptZombie(entity) {
        try {
            if (!entity || entity.isDead?.()) return false;
            if (!TARGET_CONFIG.boundaryCheck(entity.getX(), entity.getY(), entity.getZ())) return false;

            const name = this.cleanName(entity.getName?.()).toLowerCase();
            if (name && name !== 'zombie' && name !== 'zombie villager') {
                return this.matchesTargetName(name);
            }

            return this.isInHubArea() && this.isNearCrypts();
        } catch (e) {
            return false;
        }
    }

    getEntityUuid(entity) {
        try {
            if (!entity) return null;
            if (entity.getUUID) return entity.getUUID().toString();
            if (entity.toMC?.().getUuid) return entity.toMC().getUuid().toString();
        } catch (e) {}
        return null;
    }

    cleanName(text) {
        return ChatLib.removeFormatting(String(text || '')).trim();
    }

    getWorldText() {
        const parts = [];
        try {
            (Scoreboard.getLines?.() || []).forEach((line) => parts.push(ChatLib.removeFormatting(String(line))));
        } catch (e) {}
        try {
            (TabList.getNames?.() || []).forEach((entry) => parts.push(ChatLib.removeFormatting(String(entry?.getName?.() || entry))));
        } catch (e) {}
        return parts.join('\n');
    }

    getHealthPercent() {
        try {
            const player = Player.getPlayer();
            const health = player?.getHealth?.();
            const maxHealth = player?.getMaxHealth?.();
            if (!Number.isFinite(health) || !Number.isFinite(maxHealth) || maxHealth <= 0) return 100;
            return (health / maxHealth) * 100;
        } catch (e) {
            return 100;
        }
    }

    getRomanTier() {
        return ['I', 'II', 'III', 'IV', 'V'][Math.max(1, Math.min(5, this.slayerTier)) - 1] || 'IV';
    }

    distanceTo(pos) {
        return Math.hypot(Player.getX() - pos.x, Player.getY() - pos.y, Player.getZ() - pos.z);
    }

    getBossesPerHour() {
        const bosses = OverlayManager.getTrackedValue(this.oid, 'bosses', 0);
        const elapsedHours = OverlayManager.getSessionElapsedMs(this.oid) / 3600000;
        if (elapsedHours <= 0) return '0';
        return (bosses / elapsedHours).toFixed(1);
    }
}

new RevenantSlayer();
