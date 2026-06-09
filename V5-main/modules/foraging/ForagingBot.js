import { PathManager, Vec3d } from '../../utils/Constants';
import { MathUtils } from '../../utils/Math';
import { ModuleBase } from '../../utils/ModuleBase';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { EtherwarpPathfinder } from '../../utils/pathfinder/EtherwarpPathfinder';
import { Guis } from '../../utils/player/Inventory';
import { Keybind } from '../../utils/player/Keybinding';
import { Rotations } from '../../utils/player/Rotations';
import { Raytrace } from '../../utils/Raytrace';
import Render from '../../utils/render/Render';
import { ScheduleTask } from '../../utils/ScheduleTask';
import { Utils } from '../../utils/Utils';

const FORAGING_STATS_FILE = 'foragingstats.json';
const FIG_TREE_TOUGHNESS = 7;
const MAX_SWEEP_BLOCKS = 35;
const FALLBACK_SWEEP = 7;
const FALLBACK_LOGS_PER_HIT = 2;
const FIG_LOG_BLOCK_ID = 80;
const SCAN_BATCH_Y_RADIUS = 34;
const TREE_BLACKLIST_MS = 10000;
const REGEN_TREE_BLACKLIST_MS = 30000;
const LANDING_BLACKLIST_MS = 12000;
const MINING_RESCAN_MS = 2500;
const BLOCK_REACH = 5.2;
const MINING_AIM_THRESHOLD = 3.5;
const MINING_AIM_SETTLED_THRESHOLD = 1.15;
const MINING_ROTATION_REQUEST_MS = 120;
const MINING_FINE_ROTATION_REQUEST_MS = 350;
const MAX_MINING_PITCH = 50;
const MAX_JUMP_MINING_PITCH = 74;
const TRUNK_MINING_FLAT_DIST = 3.6;
const BLOCK_MINING_FLAT_DIST = 4.2;
const HIGH_AIM_UPWARP_MS = 1800;
const MINING_STALL_MS = 4000;
const JUMP_MINING_STALL_MS = 2500;
const MINING_NO_BREAK_SKIP_MS = 1500;
const REGEN_TREE_MSG = /cannot damage a tree while it is regenerating/i;
const TREE_GIFT_MSG = /tree gift/i;
const GIFT_WAIT_MS = 6000;
const TREE_LOG_RESCAN_RADIUS = 8;
const MINING_AIM_CACHE_MS = 250;
const MINING_AIM_EYE_MOVE_SQ = 0.04;
const MINING_REACH_MARGIN = 0.25;
const MINING_TARGET_BLACKLIST_MS = 2500;
const MINING_STAND_ARRIVE_DIST = 0.55;
const TREE_APPROACH_RETRY_LIMIT = 1;
const TREE_APPROACH_STAND_MARGIN = 0.45;
const MINING_STAND_STUCK_MS = 1400;
const MINING_STAND_PROGRESS_MARGIN = 0.18;
const MINING_STAND_PATH_RETRY_LIMIT = 2;
const MINING_OUT_OF_REACH_NUDGE = 0.65;
const MINING_OUT_OF_REACH_MIN_FLAT = 0.25;
const MINING_AIM_SMOOTH_ALPHA = 0.34;
const MINING_AIM_DRIFT = 0.035;
const BIG_TREE_MAX_VERTICAL_SPAN = 15;
const AXE_THROW_INTERVAL_MS = 150;
const ETHERWARP_WALK_MANA_THRESHOLD = 100;
const UPWARP_PROTECTED_LOG_RADIUS = 1;
const NEAREST_TREE_SCAN_COLUMNS = 900;
const NEAREST_TREE_CANDIDATE_LIMIT = 4;
const NEAREST_TREE_MIN_TRUNK_RUN = 3;
const NEAREST_TREE_TRUNK_SEPARATION = 5;
const DEBUG_RENDER_LOG_LIMIT = 320;
const MINING_AIM_OFFSETS = [
    [0.5, 0.55, 0.5],
    [0.5, 0.35, 0.5],
    [0.5, 0.75, 0.5],
    [0.5, 0.55, 0.08],
    [0.5, 0.55, 0.92],
    [0.08, 0.55, 0.5],
    [0.92, 0.55, 0.5],
    [0.5, 0.92, 0.5],
    [0.5, 0.12, 0.5],
];
const JUMP_MINING_EYE_GAIN = 0.9;

const STATES = {
    WAITING: 'Waiting',
    COLLECTING_STATS: 'Collecting Stats',
    SCANNING: 'Scanning',
    TRAVELING: 'Traveling',
    MINING_BASE: 'Mining Base',
    UPWARPING: 'Upwarping',
    MINING_UPPER: 'Mining Upper',
    COOLDOWN: 'Cooldown',
    RECOVERY: 'Recovery',
};

const TRAVEL_MODES = {
    WALK: 'Walk',
    ETHERWARP: 'Etherwarp',
    NONE: 'None',
};

const PACING = {
    Conservative: { min: 260, max: 620, rotation: 0.85, miningRotation: 2.2, etherwarpPreAimMs: 70, etherwarpPostAimMs: 38, etherwarpHopDelayTicks: 3, etherwarpRotation: 0.88, etherwarpMinTurnMs: 60, etherwarpDegreesPerSecond: 300 },
    Balanced: { min: 140, max: 380, rotation: 1.0, miningRotation: 2.8, etherwarpPreAimMs: 55, etherwarpPostAimMs: 30, etherwarpHopDelayTicks: 2, etherwarpRotation: 0.95, etherwarpMinTurnMs: 45, etherwarpDegreesPerSecond: 340 },
    Fast: { min: 70, max: 220, rotation: 1.15, miningRotation: 3.4, etherwarpPreAimMs: 42, etherwarpPostAimMs: 22, etherwarpHopDelayTicks: 2, etherwarpRotation: 1.05, etherwarpMinTurnMs: 35, etherwarpDegreesPerSecond: 380 },
};

const cleanText = (value) => ChatLib.removeFormatting(String(value || '')).trim();
const normalizeText = (value) => cleanText(value).toLowerCase();
const blockKey = (x, y, z) => `${x},${y},${z}`;
const treeKey = (tree) => (tree?.trunk ? blockKey(tree.trunk.x, tree.trunk.minY, tree.trunk.z) : 'none');

const parseNumber = (value) => {
    const parsed = Number(String(value || '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
};

const randomDelay = (mode) => {
    const profile = PACING[mode] || PACING.Balanced;
    return Utils.randomInt(profile.min, profile.max);
};

class ForagingStatsCollector {
    constructor() {
        this.stats = Utils.getConfigFile(FORAGING_STATS_FILE) || {};
        this.isCollecting = false;
        this.checkedThisSession = false;
        this.visiblePointCache = new Map();
        this.collectionCallback = null;
    }
    
    getCachedVisiblePoint(block) {
            const key = `${block.x},${block.y},${block.z}`;
        
            const cached = this.visiblePointCache.get(key);
        
            if (cached && Date.now() - cached.time < 2000)
                return cached.point;
        
            const point = Raytrace.getVisiblePoint(
                block.x,
                block.y,
                block.z,
                false
            );
        
            this.visiblePointCache.set(key, {
                point,
                time: Date.now()
            });
        
            return point;
        }

    shouldRefresh(refreshOnStart = true) {
        const axe = this.findBestAxe();
        if (!axe) return false;
        if (!this.stats || !this.stats.axeName) return true;
        if (this.stats.axeName !== axe.name) return true;
        return refreshOnStart && !this.checkedThisSession;
    }

    getStats() {
        return this.normalizeStats(this.stats || {}, this.findBestAxe());
    }

    refreshIfNeeded(refreshOnStart = true, onComplete = null) {
        if (!this.shouldRefresh(refreshOnStart)) {
            this.checkedThisSession = true;
            this.stats = this.normalizeStats(this.stats || {}, this.findBestAxe());
            if (typeof onComplete === 'function') onComplete(this.stats, true);
            return true;
        }
        return this.beginCollection(onComplete);
    }

    beginCollection(onComplete = null) {
        if (this.isCollecting) return true;

        const axe = this.findBestAxe();
        if (!axe) return false;

        this.isCollecting = true;
        this.collectionCallback = typeof onComplete === 'function' ? onComplete : null;

        let axeStats = {};
        try {
            this.setHeldSlotNow(axe.slot);
            axeStats = this.parseAxeStats(axe.item);
            ChatLib.command('stats');
            ScheduleTask(1, () => this.pollStatsGui(axe, axeStats, 0));
            return true;
        } catch (e) {
            console.error('Foraging stats collection failed: ' + e + e.stack);
            this.completeCollection(axe, axeStats, false);
            return false;
        }
    }

    pollStatsGui(axe, axeStats, waitedMs) {
        if (!this.isCollecting) return;

        try {
            const current = Guis.guiName();
            if (current && current.includes('Your Equipment and Stats')) {
                ScheduleTask(2, () => {
                    if (!this.isCollecting) return;

                    try {
                        const guiStats = this.parseStatsGui();
                        Guis.closeInv();
                        this.completeCollection(axe, { ...axeStats, ...guiStats }, true);
                    } catch (e) {
                        console.error('Foraging stats collection failed: ' + e + e.stack);
                        this.completeCollection(axe, axeStats, false);
                    }
                });
                return;
            }

            if (waitedMs >= 4000) {
                this.completeCollection(axe, axeStats, false);
                return;
            }

            ScheduleTask(1, () => this.pollStatsGui(axe, axeStats, waitedMs + 50));
        } catch (e) {
            console.error('Foraging stats collection failed: ' + e + e.stack);
            this.completeCollection(axe, axeStats, false);
        }
    }

    completeCollection(axe, rawStats, ok) {
        this.stats = this.normalizeStats(rawStats || {}, axe);
        this.saveStats(this.stats);
        this.checkedThisSession = true;
        this.isCollecting = false;

        const callback = this.collectionCallback;
        this.collectionCallback = null;
        if (typeof callback === 'function') callback(this.stats, !!ok);
    }

    parseStatsGui() {
        const container = Player.getContainer();
        const items = container?.getItems?.() || [];
        let totalSweep = 0;
        let foragingFortune = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item) continue;
            const text = this.getItemText(item);
            totalSweep = Math.max(totalSweep, this.extractStat(text, /(?:^|\s)(?:total\s+)?sweep[:\s+]*\+?([\d,.]+)/i));
            totalSweep = Math.max(totalSweep, this.extractStat(text, /([\d,.]+)\s*\u222E\s*sweep/i));
            foragingFortune = Math.max(foragingFortune, this.extractStat(text, /foraging\s+fortune[:\s+]*\+?([\d,.]+)/i));
        }

        return { totalSweep, foragingFortune };
    }

    parseAxeStats(item) {
        if (!item) return {};

        const text = this.getItemText(item);
        const lines = this.getLoreLines(item);
        const axeBaseSweep = this.extractStat(text, /sweep:\s*\+?([\d,.]+)/i);
        const currentBonus = this.extractStat(text, /current\s+bonus:\s*\+?([\d,.]+)\s*\u222E/i);
        const firstImpression = this.extractRomanLevel(text, /first\s+impression\s+([ivx]+)/i);
        const figSharpening = this.extractAttributeValue(lines, /fig\s+sharpening/i);
        const booster = this.extractStat(text, /sweep\s+booster.*?\+?([\d,.]+)/i);

        return {
            axeBaseSweep,
            currentBonus,
            firstImpression,
            figSharpening,
            booster,
        };
    }

    extractAttributeValue(lines, labelPattern) {
        for (let i = 0; i < lines.length; i++) {
            if (!labelPattern.test(lines[i])) continue;
            const window = lines.slice(i, Math.min(lines.length, i + 3)).join(' ');
            const rangeMatch = window.match(/\+?([\d,.]+)\s*(?:\u2794|->|to)\s*\+?([\d,.]+)/i);
            if (rangeMatch) return parseNumber(rangeMatch[1]);
            const flatMatch = window.match(/\+?([\d,.]+)\s*(?:\u222E|sweep)/i);
            if (flatMatch) return parseNumber(flatMatch[1]);
        }
        return 0;
    }

    extractStat(text, pattern) {
        const match = String(text || '').match(pattern);
        return match ? parseNumber(match[1]) : 0;
    }

    extractRomanLevel(text, pattern) {
        const match = String(text || '').match(pattern);
        if (!match) return 0;
        const roman = String(match[1]).toUpperCase();
        const values = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
        return values[roman] || 0;
    }

    normalizeStats(raw, axe = null) {
        const currentAxe = axe || this.findBestAxe();
        const totalSweep = Math.max(0, Number(raw.totalSweep) || 0);
        const axeBaseSweep = Math.max(0, Number(raw.axeBaseSweep) || 0);
        const currentBonus = Math.max(0, Number(raw.currentBonus) || 0);
        const firstImpression = Math.max(0, Number(raw.firstImpression) || 0);
        const figSharpening = Math.max(0, Number(raw.figSharpening) || 0);
        const booster = Math.max(0, Number(raw.booster) || 0);
        const fallback = axeBaseSweep + currentBonus + firstImpression + figSharpening + booster;
        const effectiveFigSweep = Math.max(FALLBACK_SWEEP, totalSweep || fallback || FALLBACK_SWEEP);
        const logsPerHit = Math.max(1, Math.min(MAX_SWEEP_BLOCKS, 1 + Math.floor(effectiveFigSweep / FIG_TREE_TOUGHNESS)));

        return {
            axeName: currentAxe?.name || raw.axeName || 'Unknown Axe',
            axeSlot: currentAxe?.slot ?? raw.axeSlot ?? -1,
            totalSweep,
            axeBaseSweep,
            currentBonus,
            firstImpression,
            figSharpening,
            booster,
            foragingFortune: Math.max(0, Number(raw.foragingFortune) || 0),
            effectiveFigSweep,
            logsPerHit: Number.isFinite(logsPerHit) ? logsPerHit : FALLBACK_LOGS_PER_HIT,
            collectedAt: Date.now(),
        };
    }

    saveStats(stats) {
        Utils.writeConfigFile(FORAGING_STATS_FILE, stats);
        this.stats = stats;
    }

    setHeldSlotNow(slot) {
        if (slot < 0 || slot > 8) return;
        try {
            Player.setHeldItemIndex(slot);
        } catch (e) {
            Guis.setItemSlot(slot);
        }
    }

    findBestAxe() {
        const inventory = Player.getInventory();
        if (!inventory) return null;

        const candidates = [];
        for (let slot = 0; slot < Math.min(9, inventory.getSize()); slot++) {
            const item = inventory.getStackInSlot(slot);
            if (!item || typeof item.getName !== 'function') continue;

            const name = cleanText(item.getName());
            const lower = name.toLowerCase();
            let priority = 0;
            if (lower.includes('figstone splitter')) priority = 100;
            else if (lower.includes('fig hew')) priority = 90;
            else if (lower.includes('treecapitator')) priority = 70;
            else if (/(^|[^a-z])axe([^a-z]|$)/i.test(lower)) priority = 50;
            if (priority <= 0) continue;

            const axeStats = this.parseAxeStats(item);
            candidates.push({
                slot,
                item,
                name,
                priority: priority + (axeStats.axeBaseSweep || 0),
            });
        }

        candidates.sort((a, b) => b.priority - a.priority);
        return candidates[0] || null;
    }

    getLoreLines(item) {
        try {
            return item?.getLore?.()?.map((line) => cleanText(line)) || [];
        } catch (e) {
            return [];
        }
    }

    getItemText(item) {
        const parts = [cleanText(item?.getName?.())].concat(this.getLoreLines(item));
        return parts.join(' ');
    }
}

class ForagingTravelPlanner {
    constructor(macro) {
        this.macro = macro;
    }

    chooseWalkTravel(tree, reason = 'walk') {
        const baseAnchor = { x: tree.trunk.x, y: tree.trunk.minY, z: tree.trunk.z };
        const walkGoal = this.resolveLanding(baseAnchor, 2, 3) || this.resolveWalkFallback(baseAnchor) || baseAnchor;

        return {
            mode: TRAVEL_MODES.WALK,
            goal: [walkGoal.x, walkGoal.y, walkGoal.z],
            landing: walkGoal,
            reason,
        };
    }

    resolveWalkFallback(anchor) {
        if (typeof this.macro.resolveWalkGoalNear !== 'function') return null;

        const preferredY = Math.floor(Player.getY()) - 1;
        const offsets = [
            [1.8, 0],
            [-1.8, 0],
            [0, 1.8],
            [0, -1.8],
            [1.8, 1.8],
            [1.8, -1.8],
            [-1.8, 1.8],
            [-1.8, -1.8],
        ];

        for (let i = 0; i < offsets.length; i++) {
            const [dx, dz] = offsets[i];
            const x = anchor.x + 0.5 + dx;
            const z = anchor.z + 0.5 + dz;
            const goal = this.macro.resolveWalkGoalNear(x, z, preferredY) || this.macro.resolveWalkGoalNear(x, z, anchor.y);
            if (goal) return { x: goal[0], y: goal[1], z: goal[2] };
        }

        return null;
    }

    chooseBaseTravel(tree) {
        const baseAnchor = { x: tree.trunk.x, y: tree.trunk.minY, z: tree.trunk.z };
        const etherwarpGoal = this.resolveLanding(baseAnchor, 5, 6);
        const walkTravel = this.chooseWalkTravel(tree, 'close');
        const walkGoal = walkTravel.landing;
        
        const dist = MathUtils.getDistanceToPlayer(walkGoal.x, walkGoal.y, walkGoal.z);
        const flat = dist.distanceFlat || 0;
        const vertical = Math.abs((Player.getY() || 0) - walkGoal.y);
        const shouldWalk = flat <= this.macro.walkDistanceLimit && vertical <= 4;
        const shouldEtherwarp =
            this.macro.useEtherwarpTravel &&
            etherwarpGoal &&
            (flat >= this.macro.etherwarpDistanceThreshold ||
                vertical >= this.macro.verticalEtherwarpThreshold);

        if (shouldEtherwarp) {
            return {
                mode: TRAVEL_MODES.ETHERWARP,
                goal: etherwarpGoal,
                landing: etherwarpGoal,
                reason: 'far or vertical',
            };
        }

        walkTravel.reason = shouldWalk ? 'close' : 'etherwarp unavailable';
        return walkTravel;
    }

    chooseUpwarpTravel(tree, remainingLogs) {
        if (!this.macro.useUpwardEtherwarp || !this.macro.useEtherwarpTravel) return null;
        if (!remainingLogs.length) return null;

        const highestUseful = remainingLogs.reduce((best, block) => (block.y > best.y ? block : best), remainingLogs[0]);
        const anchor = { x: tree.trunk.x, y: Math.max(tree.trunk.minY + 1, highestUseful.y), z: tree.trunk.z };
        const goal = this.resolveLanding(anchor, 6, 9);
        if (!goal) return null;

        const vertical = goal.y - Math.floor(Player.getY());
        if (vertical < 1) return null;

        return {
            mode: TRAVEL_MODES.ETHERWARP,
            goal,
            landing: goal,
            reason: 'upper trunk',
        };
    }

    resolveLanding(anchor, radius = 4, maxDistance = 5) {
        const ax = Math.floor(Number(anchor?.x));
        const ay = Math.floor(Number(anchor?.y));
        const az = Math.floor(Number(anchor?.z));
        if (![ax, ay, az].every(Number.isFinite)) return null;

        const support = EtherwarpPathfinder.getPlayerSupportBlock();
        const sortOrigin = support || {
            x: Math.floor(Player.getX()),
            y: Math.floor(Player.getY()),
            z: Math.floor(Player.getZ()),
        };

        const result = PathManager.getEtherwarpLandingCandidates(ax, ay, az, radius, maxDistance, sortOrigin.x, sortOrigin.y, sortOrigin.z);
        if (!result?.goals) return null;

        const goals = result.goals;
        for (let i = 0; i + 2 < goals.length; i += 3) {
            const goal = {
                x: Number(goals[i]),
                y: Number(goals[i + 1]),
                z: Number(goals[i + 2]),
            };
            if (this.macro.isLandingBlacklisted(goal)) continue;
            return goal;
        }
        return null;
    }
}

class ForagingBot extends ModuleBase {
    constructor() {
        super({
            name: 'Foraging Bot',
            subcategory: 'Foraging',
            description: 'Dynamically farms full Fig Tree trunks on Galatea.',
            tooltip: 'Scans full Fig Tree trunks, plans walking/Etherwarp travel, and mines trunk logs with Sweep-aware scoring.',
            theme: '#4cbf7b',
            showEnabledToggle: false,
            isMacro: true,
        });

        this.bindToggleKey();

        this.statsCollector = new ForagingStatsCollector();
        this.travelPlanner = new ForagingTravelPlanner(this);

        this.state = STATES.WAITING;
        this.status = 'Idle';
        this.refreshStatsOnStart = true;
        this.scanRadius = 48;
        this.walkDistanceLimit = 18;
        this.etherwarpDistanceThreshold = 28;
        this.verticalEtherwarpThreshold = 7;
        this.minLogsForUpwarpSetting = 1;
        this.useEtherwarpTravel = true;
        this.useUpwardEtherwarp = true;
        this.useAxeThrowing = true;
        this.dontGoAfterBigTrees = true;
        this.pacingMode = 'Balanced';
        this.debug = false;

        this.currentTree = null;
        this.currentTravel = null;
        this.currentTargetBlock = null;
        this._upwarpMiningLock = null;
        this.lastScanTrees = [];
        this.blacklistedTrees = new Map();
        this.blacklistedLandings = new Map();
        this.nextActionAt = 0;
        this.nextScanAt = 0;
        this.pathActive = false;
        this.pathToken = 0;
        this.lastMineRescanAt = 0;
        this.needsFullScan = true;
        this.lastFullScanAt = 0;
        this._scanOffsetCache = new Map();
        this._nearestScanMisses = 0;
        this.blockCache = new Map();
        this.lastCacheClear = 0;
        this._remainingLogsCache = new Map();
        this._remainingLogsCacheTime = 0;
        this._miningProbeCache = new Map();
        this._miningProbeFrameKey = null;
        this._pruneCounter = 0;
        this._miningStallCount = -1;
        this._miningStallSince = 0;
        this._miningBreakCount = -1;
        this._miningBreakSince = 0;
        this._miningHighAimSince = 0;
        this._miningAimCache = new Map();
        this._miningSmoothAimPoint = null;
        this._miningSmoothAimKey = null;
        this._miningAimSeed = 0;
        this._miningRotationAimKey = null;
        this._lastMiningRotationAt = 0;
        this._miningNoAimTargetKey = null;
        this._miningNoAimSince = 0;
        this._miningTargetBlacklist = new Map();
        this._approachRetryCount = 0;
        this._miningStandMove = null;
        this._miningStandPathKey = null;
        this._miningStandPathFailures = 0;
        this.miningJumpPhase = false;
        this.holdingMiningJump = false;
        this.treeGiftReceived = false;
        this._giftWaitSince = 0;
        this._treeEngaged = false;
        this._treeLogsPrimed = false;
        this._lastAxeThrowAt = 0;
        this.stats = this.statsCollector.getStats();

        this.registerSettings();
        this.registerEvents();
        this.createMacroOverlay();
    }

    registerSettings() {
        this.addToggle('Refresh Stats On Start', (value) => (this.refreshStatsOnStart = !!value), 'Collect /stats data before starting.', true);
        this.addSlider('Scan Radius', 16, 80, 48, (value) => (this.scanRadius = Math.floor(value)), 'Blocks scanned around the player.');
        this.addSlider('Walk Distance Limit', 6, 36, 18, (value) => (this.walkDistanceLimit = Math.floor(value)), 'Close targets are walked to save mana.');
        this.addSlider(
            'Etherwarp Distance Threshold',
            12,
            60,
            28,
            (value) => (this.etherwarpDistanceThreshold = Math.floor(value)),
            'Prefer Etherwarp beyond this flat distance.'
        );
        this.addSlider(
            'Vertical Etherwarp Threshold',
            3,
            18,
            7,
            (value) => (this.verticalEtherwarpThreshold = Math.floor(value)),
            'Prefer Etherwarp when useful logs are this much higher.'
        );
        this.addSlider(
            'Min Logs For Upwarp',
            1,
            16,
            1,
            (value) => (this.minLogsForUpwarpSetting = Math.floor(value)),
            'Minimum remaining upper trunk logs before an upward Etherwarp (also upwarps when stuck below unreachable logs).'
        );
        this.addToggle('Use Etherwarp Travel', (value) => (this.useEtherwarpTravel = !!value), 'Use chained Etherwarp for distant tree travel.', true);
        this.addToggle('Use Upward Etherwarp', (value) => (this.useUpwardEtherwarp = !!value), 'Use Etherwarp to reach high trunk sections.', true);
        this.addToggle('DONT go after big trees', (value) => (this.dontGoAfterBigTrees = !!value), 'Ignore oversized Fig Trees that extend too far upward.', true);
        this.addMultiToggle(
            'Legit Movement Pacing',
            ['Balanced', 'Conservative', 'Fast'],
            true,
            (options) => {
                this.pacingMode = options.find((option) => option.enabled)?.name || 'Balanced';
            },
            'Controls delay between scan, movement, rotation, and mining actions.',
            'Balanced'
        );
        this.addToggle('Debug Render', (value) => (this.debug = !!value), 'Render scanned trees, target, and landing decisions.', false);
    }

    registerEvents() {
        this.on('tick', () => this.onTick());
        this.on('postRenderWorld', () => this.renderDebug());
        this.on('worldUnload', () => this.handleWorldUnload());
        this.on('chat', (event) => this.onChat(event));
    }

    createMacroOverlay() {
        this.createOverlay([
            {
                title: 'Status',
                data: {
                    State: () => this.state,
                    Status: () => this.status,
                    Sweep: () => `${Math.floor(this.stats?.effectiveFigSweep || FALLBACK_SWEEP)} (${this.getLogsPerHit()}/hit)`,
                    Trees: () => this.lastScanTrees.length,
                    Target: () => (this.currentTree ? treeKey(this.currentTree) : 'None'),
                    Strategy: () =>
                        this.treeGiftReceived
                            ? 'Gift received'
                            : this.miningJumpPhase
                              ? 'Jumping upper'
                              : 'Full tree',
                    Travel: () => this.currentTravel?.mode || 'None',
                },
            },
        ]);
    }

    onTick() {
        if (!this.enabled || !World.isLoaded() || !Player.getPlayer()) return;
        if (Client.isInChat() || (Client.isInGui() && !this.isStatsGuiOpen())) return;
        const isMining = this.state === STATES.MINING_BASE || this.state === STATES.MINING_UPPER;
        if (!isMining && Date.now() < this.nextActionAt) return;

        if (++this._pruneCounter % 20 === 0) this.pruneBlacklists();

        if (Utils.area() !== 'Galatea') {
            this.status = 'Waiting for Galatea';
            this.stopActiveControls();
            return;
        }

        switch (this.state) {
            case STATES.COLLECTING_STATS:
                break;
            case STATES.SCANNING:
                this.handleScanning();
                break;
            case STATES.TRAVELING:
                this.handleTraveling();
                break;
            case STATES.MINING_BASE:
            case STATES.MINING_UPPER:
                this.handleMining();
                break;
            case STATES.UPWARPING:
                this.handleUpwarping();
                break;
            case STATES.COOLDOWN:
                this.transitionTo(STATES.SCANNING, 'cooldown complete', 50);
                break;
            case STATES.RECOVERY:
                this.recover();
                break;
        }
    }

    isStatsGuiOpen() {
        const gui = Guis.guiName();
        return gui && gui.includes('Your Equipment and Stats');
    }

    transitionTo(state, status = null, delayMs = null) {
        this.state = state;
        if (status) this.status = status;
        this.nextActionAt = Date.now() + (delayMs == null ? randomDelay(this.pacingMode) : delayMs);
    }

    handleScanning() {
        if (this.needsFullScan) {
            if (Date.now() < this.nextScanAt) return;

            this.stopActiveControls();
            this.stats = this.statsCollector.getStats();
            this.lastScanTrees = this.scanForFigTrees();
            this.needsFullScan = false;
            this.lastFullScanAt = Date.now();
            this.status = `Scanned ${this.lastScanTrees.length} fig trees`;
        }

        const target = this.chooseBestTree(this.lastScanTrees);
        if (!target) {
            this._nearestScanMisses++;
            this.needsFullScan = true;
            this.lastFullScanAt = 0;
            this.status = 'No nearby trunk found, rescanning';
            this.transitionTo(STATES.SCANNING, this.status, 180);
            return;
        }

        this._nearestScanMisses = 0;
        this.currentTree = target;
        this.currentTargetBlock = null;
        this.clearUpwarpMiningLock();
        this._approachRetryCount = 0;
        this.resetMiningStandRecovery();
        this.currentTravel = this.travelPlanner.chooseBaseTravel(target);
        this.status = `Target ${treeKey(target)}`;
        this.transitionTo(STATES.TRAVELING, this.status);
    }

    handleTraveling() {
        if (!this.currentTree || !this.currentTravel) {
            this.transitionTo(STATES.SCANNING, 'missing target');
            return;
        }

        if (this.isTreeApproachReady(this.currentTree)) {
            this.beginMiningAtCurrentTree('At trunk');
            return;
        }

        if (this.maybeFallbackFromLowEtherwarpMana()) return;

        if (this.pathActive || Pathfinder.isPathing() || EtherwarpPathfinder.isPathing()) {
            this.status = `${this.currentTravel.mode} to trunk`;
            return;
        }

        this.startTravel(this.currentTravel, () => {
            if (!this.enabled) return;
            this.pathActive = false;
            this.finishBaseTravel('At trunk');
        });
    }

    handleUpwarping() {
        if (!this.currentTree) {
            this.transitionTo(STATES.SCANNING, 'missing upwarp target');
            return;
        }

        if (this.maybeFallbackFromLowEtherwarpMana()) return;

        if (this.pathActive || EtherwarpPathfinder.isPathing()) {
            this.status = 'Etherwarping upward';
            return;
        }

        const remaining = this.getRemainingTrunkLogs(this.currentTree);
        let upwarp = this.currentTravel?.mode === TRAVEL_MODES.ETHERWARP ? this.currentTravel : null;
        if (!upwarp) {
            upwarp = this.travelPlanner.chooseUpwarpTravel(this.currentTree, remaining);
        }
        if (!upwarp) {
            this.status = 'Upwarp search failed, retrying';
            this.transitionTo(STATES.MINING_BASE, this.status, 400);
            return;
        }

        this.currentTravel = upwarp;
        if (this.isEtherwarpManaLow() && this.queueWalkFallback('Low mana, walking', 'low mana')) return;

        this.startTravel(upwarp, () => {
            if (!this.enabled) return;
            this.pathActive = false;
            this.resetMiningSession();
            this.setUpwarpMiningLock(this.currentTree, upwarp);
            this.currentTravel = null;
            this.transitionTo(STATES.MINING_UPPER, 'Upper trunk', 0);
        });
    }

    clearBlockCache() {
        if (!this.lastCacheClear || Date.now() - this.lastCacheClear > 8000) {
            this.blockCache = new Map();
            this.lastCacheClear = Date.now();
        }
    }

    startTravel(travel, onSuccess) {
        const token = ++this.pathToken;
        this.pathActive = true;
        this.stopActiveControls();
        Rotations.stopRotation();
        let activeTravel = travel;

        if (activeTravel?.mode === TRAVEL_MODES.ETHERWARP && this.isEtherwarpManaLow()) {
            activeTravel = this.currentTree ? this.travelPlanner.chooseWalkTravel(this.currentTree, 'low mana') : null;
            if (activeTravel) this.currentTravel = activeTravel;
        }

        if (activeTravel?.mode === TRAVEL_MODES.ETHERWARP && this.useEtherwarpTravel && activeTravel.goal) {
            const goal = activeTravel.goal;
            const started = EtherwarpPathfinder.findPath(goal, {
                silent: true,
                restoreSlot: true,
                ...this.getEtherwarpTravelOptions(),
                onSuccess: () => {
                    if (!this.enabled || token !== this.pathToken) return;
                    this.pathActive = false;
                    onSuccess();
                },
                onFail: () => {
                    if (!this.enabled || token !== this.pathToken) return;
                    this.pathActive = false;
                    this.blacklistLanding(goal);
                    if (this.queueWalkFallback('Etherwarp failed, walking', 'etherwarp failed')) return;
                    this.failCurrentTravel('Etherwarp failed');
                },
            });

            if (started) return;
            this.blacklistLanding(goal);
            activeTravel = this.currentTree ? this.travelPlanner.chooseWalkTravel(this.currentTree, 'etherwarp unavailable') : null;
            if (activeTravel) this.currentTravel = activeTravel;
            this.pathActive = false;
        }

        if (activeTravel?.mode === TRAVEL_MODES.ETHERWARP) {
            activeTravel = this.currentTree ? this.travelPlanner.chooseWalkTravel(this.currentTree, 'etherwarp unavailable') : null;
            if (activeTravel) this.currentTravel = activeTravel;
        }

        const walkGoal = this.normalizeWalkGoal(activeTravel?.goal);
        if (!walkGoal) {
            this.pathActive = false;
            this.failCurrentTravel('Invalid travel goal');
            return;
        }

        Pathfinder.findPath([walkGoal], (success) => {
            if (!this.enabled || token !== this.pathToken) return;
            this.pathActive = false;
            if (success) {
                onSuccess();
                return;
            }
            this.failCurrentTravel('Travel failed');
        });
    }

    finishBaseTravel(status = 'At trunk') {
        if (!this.currentTree) {
            this.failCurrentTravel('Missing tree after travel');
            return;
        }

        if (this.isTreeApproachReady(this.currentTree)) {
            this.beginMiningAtCurrentTree(status);
            return;
        }

        if (this.tryStartApproachRetry('Refining approach')) return;

        this.failCurrentTravel('Approach blocked');
    }

    beginMiningAtCurrentTree(status = 'At trunk') {
        this.pathActive = false;
        this.currentTravel = null;
        Pathfinder.resetPath();
        this.clearUpwarpMiningLock();
        this.resetMiningSession();
        this.treeGiftReceived = false;
        this._giftWaitSince = 0;
        this._approachRetryCount = 0;
        this.transitionTo(STATES.MINING_BASE, status, 0);
    }

    isEtherwarpManaLow() {
        if (Utils.isRecentlyOutOfMana?.(1500)) return true;

        const mana = Utils.getCurrentMana();
        const currentMana = Number(mana);
        return mana !== null && Number.isFinite(currentMana) && currentMana < ETHERWARP_WALK_MANA_THRESHOLD;
    }

    maybeFallbackFromLowEtherwarpMana() {
        if (this.currentTravel?.mode !== TRAVEL_MODES.ETHERWARP) return false;
        if (!this.pathActive && !EtherwarpPathfinder.isPathing()) return false;
        if (!this.isEtherwarpManaLow()) return false;

        this.pathToken++;
        this.pathActive = false;
        EtherwarpPathfinder.cancel(true);
        Rotations.stopRotation();

        if (this.queueWalkFallback('Low mana, walking', 'low mana')) return true;
        this.failCurrentTravel('Low mana');
        return true;
    }

    queueWalkFallback(status, reason) {
        const fallback = this.currentTree ? this.travelPlanner.chooseWalkTravel(this.currentTree, reason) : null;
        if (!fallback) return false;
        this.currentTravel = fallback;
        this.transitionTo(STATES.TRAVELING, status, 100);
        return true;
    }

    failCurrentTravel(status) {
        this.pathActive = false;
        this.blacklistCurrentTree(TREE_BLACKLIST_MS);
        this.currentTree = null;
        this.currentTargetBlock = null;
        this.currentTravel = null;
        this.clearUpwarpMiningLock();
        this.resetMiningStandRecovery();
        this.needsFullScan = true;
        this.lastFullScanAt = 0;
        this.transitionTo(STATES.SCANNING, status, 300);
    }

    normalizeWalkGoal(goal) {
        let x;
        let y;
        let z;
        if (Array.isArray(goal)) {
            x = Number(goal[0]);
            y = Number(goal[1]);
            z = Number(goal[2]);
        } else if (goal) {
            x = Number(goal.x);
            y = Number(goal.y);
            z = Number(goal.z);
        }
        if (![x, y, z].every(Number.isFinite)) return null;
        return [Math.floor(x), Math.floor(y), Math.floor(z)];
    }

    getCurrentSupportBlock(fallback = null) {
        const support = EtherwarpPathfinder.getPlayerSupportBlock?.();
        if (support && [support.x, support.y, support.z].every(Number.isFinite)) {
            return {
                x: Math.floor(support.x),
                y: Math.floor(support.y),
                z: Math.floor(support.z),
            };
        }

        const fallbackPoint = this.normalizeWalkGoal(fallback);
        if (fallbackPoint) {
            return {
                x: fallbackPoint[0],
                y: fallbackPoint[1],
                z: fallbackPoint[2],
            };
        }

        return {
            x: Math.floor(Player.getX()),
            y: Math.floor(Player.getY() - 0.001),
            z: Math.floor(Player.getZ()),
        };
    }

    setUpwarpMiningLock(tree, travel = null) {
        if (!tree) return;

        const landing = travel?.landing || travel?.goal || null;
        const support = this.getCurrentSupportBlock(landing);
        this._upwarpMiningLock = {
            treeKey: treeKey(tree),
            x: support.x,
            y: support.y,
            z: support.z,
        };
        this.currentTargetBlock = null;
        this.clearMiningStandProgress();
        Pathfinder.resetPath();
        Keybind.stopMovement();
    }

    clearUpwarpMiningLock() {
        this._upwarpMiningLock = null;
    }

    isUpwarpMiningLocked(tree = this.currentTree) {
        return !!this._upwarpMiningLock && !!tree && this._upwarpMiningLock.treeKey === treeKey(tree);
    }

    isUpwarpLockProtectedBlock(block) {
        if (!block || !this.isUpwarpMiningLocked()) return false;

        const lock = this._upwarpMiningLock;
        const dx = Math.abs(block.x - lock.x);
        const dy = Math.abs(block.y - lock.y);
        const dz = Math.abs(block.z - lock.z);

        return dx <= UPWARP_PROTECTED_LOG_RADIUS && dz <= UPWARP_PROTECTED_LOG_RADIUS && dy <= 1;
    }

    handleMining() {
        this.clearBlockCache();
        this.beginMiningProbeFrame();
        if (!this.currentTree) {
            this.transitionTo(STATES.SCANNING, 'missing mining target');
            return;
        }

        if (this.pathActive || Pathfinder.isPathing()) {
            Keybind.setKey('leftclick', false);
            this.syncMiningJump(false);
            this.status = 'Pathing to mining stand';
            return;
        }

        const axeSlot = this.getAxeSlot();
        if (axeSlot < 0) {
            this.message('&cNo axe found in hotbar.');
            this.toggle(false);
            return;
        }
        Guis.setItemSlot(axeSlot);

        const tree = this.currentTree;

        if (!this._treeLogsPrimed) {
            this.refreshTreeLogsFromWorld(tree, true);
            this._treeLogsPrimed = true;
            this.invalidateRemainingCache();
        }

        if (Date.now() - this.lastMineRescanAt > MINING_RESCAN_MS) {
            this.refreshTreeLogsFromWorld(tree);
            tree.expectedHits = Math.max(1, Math.ceil((tree.logBlocks?.length || 0) / this.getLogsPerHit()));
            this.lastMineRescanAt = Date.now();
            this.invalidateRemainingCache();
        }

        let remaining = this.getRemainingTreeLogs(tree);

        if (!remaining.length) {
            this.refreshTreeLogsFromWorld(tree, true);
            this.invalidateRemainingCache();
            remaining = this.getRemainingTreeLogs(tree);
        }

        if (!remaining.length) {
            if (!this._treeEngaged) {
                const earlyLogs = this.getRemainingTreeLogs(tree);
                if (this.tryStartUpwarp(tree, earlyLogs)) return;
                this.blacklistCurrentTree(8000);
                this.finishTreeAttempt('no logs at tree');
                return;
            }

            if (this.treeGiftReceived) {
                this.finishTreeAttempt('Tree gift');
                return;
            }

            this.syncMiningJump(false);
            Keybind.setKey('leftclick', false);
            if (!this._giftWaitSince) this._giftWaitSince = Date.now();

            if (Date.now() - this._giftWaitSince >= GIFT_WAIT_MS) {
                this.refreshTreeLogsFromWorld(tree, true);
                this.invalidateRemainingCache();
                remaining = this.getRemainingTreeLogs(tree);
                if (remaining.length) {
                    this._giftWaitSince = 0;
                } else {
                    this.finishTreeAttempt('Tree gift timeout');
                    return;
                }
            } else {
                this.status = 'Waiting for Tree gift';
                return;
            }
        }

        this._giftWaitSince = 0;

        const picked = this.pickMiningTarget(remaining, tree);
        let target = picked?.target || null;
        let useJump = !!picked?.needsJump;
        let needsMove = !!picked?.needsMove;
        const lockedToUpwarpBlock = this.isUpwarpMiningLocked(tree);

        if (!target && remaining.length) {
            if (this.tryStartUpwarp(tree, remaining, picked)) return;
        }

        const aimPitch = target ? this.getBlockAimAngles(target).pitch : 0;
        const playerPitch = Number.parseFloat(Player.getPitch());
        if (target && (aimPitch < -MAX_MINING_PITCH || playerPitch < -MAX_MINING_PITCH)) {
            if (!this._miningHighAimSince) this._miningHighAimSince = Date.now();
            else if (Date.now() - this._miningHighAimSince >= HIGH_AIM_UPWARP_MS) {
                if (this.tryStartUpwarp(tree, remaining, picked)) return;
            }
        } else {
            this._miningHighAimSince = 0;
        }

        const stallLimit = this.miningJumpPhase ? JUMP_MINING_STALL_MS : MINING_STALL_MS;
        const prevStallCount = this._miningStallCount;
        if (prevStallCount === remaining.length) {
            if (!this._miningStallSince) this._miningStallSince = Date.now();
            else if (Date.now() - this._miningStallSince >= stallLimit) {
                if (this.tryStartUpwarp(tree, remaining, picked)) return;
                this.finishTreeAttempt('mining stall');
                return;
            }
        } else {
            this._miningStallCount = remaining.length;
            this._miningStallSince = 0;
        }

        if (!target) {
            this.updateMiningBreakProgress(remaining, false);
            if (this.tryStartUpwarp(tree, remaining, picked)) return;
            this.finishTreeAttempt('mining stall');
            return;
        }

        if (lockedToUpwarpBlock && needsMove) {
            this.updateMiningBreakProgress(remaining, false);
            this.blacklistMiningTarget(target);
            this.currentTargetBlock = null;
            this.status = `Holding upwarp block (${remaining.length})`;
            return;
        }

        const targetProbe = picked?.probe || this.getMiningProbe(target, tree);
        if (needsMove || (!lockedToUpwarpBlock && (targetProbe?.needsMove ?? this.needsMiningMovement(target, tree)))) {
            needsMove = true;
            useJump = useJump || !!targetProbe?.needsJump;
        }

        this.miningJumpPhase = useJump;
        this.currentTargetBlock = target;
        const rawAimPoint = useJump
            ? targetProbe?.jumpAimPoint || targetProbe?.standingAimPoint || this.getJumpMiningAimPoint(target) || this.getMiningAimPoint(target)
            : targetProbe?.standingAimPoint || this.getMiningAimPoint(target);
        const aimPoint = this.getSmoothedMiningAimPoint(target, rawAimPoint);
        let aimSettled = false;

        if (!needsMove && !aimPoint) {
            this.updateMiningBreakProgress(remaining, false);
            Keybind.setKey('leftclick', false);
            this.syncMiningJump(false);
            this.resetMiningRotationTracking();
            this.blacklistMiningTarget(target);
            this.currentTargetBlock = null;
            if (this.tryStartUpwarp(tree, remaining)) return;
            this.status = `Retargeting logs (${remaining.length})`;
            return;
        }

        if (this.syncMiningMovement(target, tree, useJump, needsMove) === false) return;

        let needsRotation = true;
        if (aimPoint) {
            const aimState = this.updateMiningAimRotation(target, aimPoint);
            aimSettled = aimState.settled;
            needsRotation = aimState.needsRotation;
        }

        if (needsMove) {
            this.updateMiningBreakProgress(remaining, false);
            if (!aimPoint && this.isAtMiningStand(target, tree) && this.updateNoAimStall(target, false)) {
                this.blacklistMiningTarget(target);
                this.currentTargetBlock = null;
                this._miningNoAimTargetKey = null;
                this._miningNoAimSince = 0;
                if (this.tryStartUpwarp(tree, remaining)) return;
                this.status = `Retargeting logs (${remaining.length})`;
                return;
            }

            Keybind.setKey('leftclick', !!aimPoint && aimSettled);
            this._treeEngaged = this._treeEngaged || (!!aimPoint && aimSettled);
            this.status = useJump
                ? `Moving in to jump-mine (${remaining.length})`
                : `Moving to trunk (${remaining.length})`;
            return;
        }

        if (!aimPoint || needsRotation || !aimSettled) {
            this.updateMiningBreakProgress(remaining, false);
            Keybind.setKey('leftclick', false);

            if (this.updateNoAimStall(target, false)) {
                this.blacklistMiningTarget(target);
                this.currentTargetBlock = null;
                this._miningNoAimTargetKey = null;
                this._miningNoAimSince = 0;
                this.resetMiningRotationTracking();
                if (this.tryStartUpwarp(tree, remaining)) return;
                this.status = `Retargeting logs (${remaining.length})`;
                return;
            }

            this.status = this.miningJumpPhase
                ? `Aiming jump-mine (${remaining.length})`
                : `Aiming tree (${remaining.length})`;
            return;
        }

        this.updateNoAimStall(target, true);
        if (this.updateMiningBreakProgress(remaining, true)) return;
        this.maybeThrowAxe(target);
        Keybind.setKey('leftclick', true);
        this._treeEngaged = true;
        this.status = this.miningJumpPhase
            ? `Jump-mining (${remaining.length})`
            : `Mining tree (${remaining.length})`;
    }

    getMiningRotationAimKey(target, aimPoint) {
        const coords = this.getMiningAimCoords(aimPoint);
        if (!target || !coords) return null;
        const rounded = coords.map((value) => Math.round(Number(value) * 20));
        return `${blockKey(target.x, target.y, target.z)}>${rounded.join(',')}`;
    }

    updateMiningAimRotation(target, aimPoint) {
        if (!this.isValidMiningAimPoint(aimPoint)) {
            this.resetMiningRotationTracking();
            return { settled: false, needsRotation: true };
        }

        const angles = MathUtils.calculateAngles(aimPoint);
        const yawAbs = Math.abs(angles.yaw);
        const pitchAbs = Math.abs(angles.pitch);
        const settled = yawAbs <= MINING_AIM_SETTLED_THRESHOLD && pitchAbs <= MINING_AIM_SETTLED_THRESHOLD;
        const outsideLooseThreshold = yawAbs > MINING_AIM_THRESHOLD || pitchAbs > MINING_AIM_THRESHOLD;
        const needsRotation = !settled;

        if (needsRotation) {
            const now = Date.now();
            const aimKey = this.getMiningRotationAimKey(target, aimPoint);
            const requestInterval = outsideLooseThreshold ? MINING_ROTATION_REQUEST_MS : MINING_FINE_ROTATION_REQUEST_MS;
            if (aimKey !== this._miningRotationAimKey || now - this._lastMiningRotationAt >= requestInterval) {
                this._miningRotationAimKey = aimKey;
                this._lastMiningRotationAt = now;
                Rotations.rotateToVector(aimPoint, true, this.getMiningRotationSpeed());
            }
        }

        return {
            settled,
            needsRotation,
        };
    }

    resetMiningRotationTracking() {
        this._miningRotationAimKey = null;
        this._lastMiningRotationAt = 0;
    }

    maybeThrowAxe(target) {
        if (!this.useAxeThrowing || !target) return;

        const now = Date.now();
        if (now - this._lastAxeThrowAt < AXE_THROW_INTERVAL_MS) return;

        this._lastAxeThrowAt = now;
        Keybind.rightClick();
    }

    shouldTryUpwarp(tree, remaining, picked = undefined) {
        if (!this.useUpwardEtherwarp || !this.useEtherwarpTravel || !remaining?.length) return false;
        if (this.isUpwarpMiningLocked(tree)) return false;

        const playerY = Math.floor(Player.getY());
        const upperLogs = remaining.filter((block) => block.y > playerY + 1);
        if (!upperLogs.length) return false;

        const targetPick = picked === undefined ? this.pickMiningTarget(remaining, tree) : picked;
        if (!targetPick || targetPick.needsMove) return true;

        return remaining.length >= this.getMinLogsForUpwarp();
    }

    tryStartUpwarp(tree, remaining, picked = undefined) {
        const logs = remaining?.length ? remaining : this.getRemainingTreeLogs(tree);
        if (!this.shouldTryUpwarp(tree, logs, picked)) return false;
        const upwarp = this.travelPlanner.chooseUpwarpTravel(tree, logs);
        if (!upwarp) return false;

        this.syncMiningJump(false);
        Keybind.setKey('leftclick', false);
        Rotations.stopRotation();
        this.pathActive = false;
        this.currentTravel = upwarp;
        this.transitionTo(STATES.UPWARPING, 'Etherwarping up', 0);
        return true;
    }

    finishTreeAttempt(reason) {
        this.syncMiningJump(false);
        Keybind.setKey('leftclick', false);
        Rotations.stopRotation();
        this.pathActive = false;
        Pathfinder.resetPath();
        this.status = reason;
        this.currentTree = null;
        this.currentTargetBlock = null;
        this.currentTravel = null;
        this.clearUpwarpMiningLock();
        this.resetMiningSession();
        this.needsFullScan = true;
        this.lastFullScanAt = 0;
        this._approachRetryCount = 0;
        this.transitionTo(STATES.SCANNING, reason, 30);
    }

    recover() {
        this.stopActiveControls();
        Pathfinder.resetPath();
        EtherwarpPathfinder.cancel(true);
        this.currentTree = null;
        this.currentTravel = null;
        this.currentTargetBlock = null;
        this.clearUpwarpMiningLock();
        this.pathActive = false;
        this.needsFullScan = true;
        this.lastFullScanAt = 0;
        this._approachRetryCount = 0;
        this.resetMiningStandRecovery();
        this.transitionTo(STATES.SCANNING, 'Recovered', 200);
    }

    scanForFigTrees() {
        const blocks = this.scanFigBlocks();

        const groups = this.groupConnectedBlocks(blocks);
        const trees = [];

        groups.forEach((group) => {
            const tree = this.buildTreeCandidate(group);
            if (!tree) return;
            if (this.isTreeBlacklisted(tree)) return;
            if (this.dontGoAfterBigTrees && this.isBigTree(tree)) return;
            trees.push(tree);
        });

        return trees;
    }

    getNearestScanOffsets(radius) {
        const r = Math.max(8, Math.floor(Number(radius) || this.scanRadius));
        const cached = this._scanOffsetCache.get(r);
        if (cached) return cached;

        const offsets = [];
        const radiusSq = r * r;
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                const distSq = dx * dx + dz * dz;
                if (distSq > radiusSq) continue;
                offsets.push({ dx, dz, distSq });
            }
        }

        offsets.sort((a, b) => a.distSq - b.distSq);
        this._scanOffsetCache.set(r, offsets);
        return offsets;
    }

    findBestFigRunInColumn(x, z, yMin, yMax, distSq = 0) {
        let currentStart = null;
        let currentLength = 0;
        let bestStart = null;
        let bestLength = 0;

        const finishRun = (endY) => {
            if (currentStart == null || currentLength <= bestLength) return;
            bestStart = currentStart;
            bestLength = currentLength;
        };

        for (let y = yMin; y <= yMax; y++) {
            if (this.isFigLogAt(x, y, z)) {
                if (currentStart == null) currentStart = y;
                currentLength++;
                continue;
            }

            finishRun(y - 1);
            currentStart = null;
            currentLength = 0;
        }
        finishRun(yMax);

        if (bestStart == null || bestLength < NEAREST_TREE_MIN_TRUNK_RUN) return null;

        return {
            x,
            z,
            minY: bestStart,
            maxY: bestStart + bestLength - 1,
            distSq,
        };
    }

    collectFigBlocksNearTrunk(candidate, radius, out) {
        if (!candidate) return;

        const minY = candidate.minY - 2;
        const maxY = candidate.maxY + 14;
        for (let y = minY; y <= maxY; y++) {
            for (let x = candidate.x - radius; x <= candidate.x + radius; x++) {
                for (let z = candidate.z - radius; z <= candidate.z + radius; z++) {
                    if (!this.isFigLogAt(x, y, z)) continue;
                    const key = blockKey(x, y, z);
                    if (!out.has(key)) out.set(key, { x, y, z });
                }
            }
        }
    }

    isDistinctTrunkCandidate(candidate, candidates) {
        if (!candidate) return false;
        const minSepSq = NEAREST_TREE_TRUNK_SEPARATION * NEAREST_TREE_TRUNK_SEPARATION;
        return !candidates.some((other) => {
            const dx = candidate.x - other.x;
            const dz = candidate.z - other.z;
            return dx * dx + dz * dz <= minSepSq;
        });
    }

    scanFigBlocks() {
        const playerX = Math.floor(Player.getX());
        const playerY = Math.floor(Player.getY());
        const playerZ = Math.floor(Player.getZ());

        const radius = Math.max(8, Math.floor(this.scanRadius));
        const yRadius = SCAN_BATCH_Y_RADIUS;
        const yMin = playerY - 12;
        const yMax = playerY + yRadius;
        const offsets = this.getNearestScanOffsets(radius);
        const candidates = [];
        const baseBudget = Math.max(NEAREST_TREE_SCAN_COLUMNS, radius * 12);
        const columnBudget = Math.min(offsets.length, baseBudget * Math.max(1, Math.min(4, this._nearestScanMisses + 1)));

        const scanColumns = (start, end) => {
            for (let i = start; i < end; i++) {
                const offset = offsets[i];
                const candidate = this.findBestFigRunInColumn(playerX + offset.dx, playerZ + offset.dz, yMin, yMax, offset.distSq);
                if (!candidate) continue;
                if (!this.isDistinctTrunkCandidate(candidate, candidates)) continue;

                candidates.push(candidate);
                if (candidates.length >= NEAREST_TREE_CANDIDATE_LIMIT) return true;
            }
            return false;
        };

        scanColumns(0, columnBudget);
        if (!candidates.length && columnBudget < offsets.length) {
            scanColumns(columnBudget, Math.min(offsets.length, columnBudget * 2));
        }

        candidates.sort((a, b) => a.distSq - b.distSq);
        const found = new Map();
        for (let i = 0; i < Math.min(candidates.length, NEAREST_TREE_CANDIDATE_LIMIT); i++) {
            this.collectFigBlocksNearTrunk(candidates[i], TREE_LOG_RESCAN_RADIUS, found);
        }

        return Array.from(found.values());
    }
    isFigLogBlock(block) {
        if (!block || !block.type)
            return false;
    
        const id = block.type.getID?.();
    
        return id === FIG_LOG_BLOCK_ID;
    }

    groupConnectedBlocks(blocks) {
        const byKey = new Map();
        blocks.forEach((block) => byKey.set(blockKey(block.x, block.y, block.z), block));

        const visited = new Set();
        const groups = [];
        const neighborOffsets = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    neighborOffsets.push([dx, dy, dz]);
                }
            }
        }

        blocks.forEach((start) => {
            const startKey = blockKey(start.x, start.y, start.z);
            if (visited.has(startKey)) return;

            const queue = [start];
            const group = [];
            visited.add(startKey);

            for (let i = 0; i < queue.length; i++) {
                const current = queue[i];
                group.push(current);

                neighborOffsets.forEach(([dx, dy, dz]) => {
                    const key = blockKey(current.x + dx, current.y + dy, current.z + dz);
                    if (visited.has(key) || !byKey.has(key)) return;
                    visited.add(key);
                    queue.push(byKey.get(key));
                });
            }

            groups.push(group);
        });

        return groups;
    }

    buildTreeCandidate(group) {
        if (!group || group.length < 3) return null;

        const columns = new Map();
        group.forEach((block) => {
            const key = `${block.x},${block.z}`;
            if (!columns.has(key)) columns.set(key, []);
            columns.get(key).push(block);
        });

        let best = null;
        columns.forEach((column) => {
            column.sort((a, b) => a.y - b.y);
            const runs = this.findVerticalRuns(column);
            runs.forEach((run) => {
                if (!best || run.length > best.blocks.length) {
                    best = {
                        x: run[0].x,
                        z: run[0].z,
                        minY: run[0].y,
                        maxY: run[run.length - 1].y,
                        blocks: run,
                    };
                }
            });
        });

        if (!best || best.blocks.length < Math.min(3, this.getMinFullTrunkLogs())) return null;
        const logBlocks = group.map((b) => ({ x: b.x, y: b.y, z: b.z }));
        const trunkBlocks = best.blocks.map((b) => ({ ...b }));
        const lowerReachable = logBlocks.filter((block) => block.y <= best.minY + 5).length;
        if (lowerReachable < Math.min(3, this.getMinFullTrunkLogs())) return null;

        const dx = best.x - Player.getX();
        const dy = best.minY - Player.getY();
        const dz = best.z - Player.getZ();
        const distFlat = Math.sqrt(dx * dx + dz * dz);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const expectedHits = Math.max(1, Math.ceil(logBlocks.length / this.getLogsPerHit()));
        const trunkHeight = best.maxY - best.minY + 1;
        const highestLogY = logBlocks.reduce((maxY, block) => Math.max(maxY, block.y), best.maxY);
        const verticalSpan = highestLogY - best.minY + 1;
        const tree = {
            blocks: logBlocks,
            logBlocks,
            trunk: best,
            trunkBlocks,
            trunkHeight,
            verticalSpan,
            lowerReachable,
            expectedHits,
            distanceFlat: distFlat || 0,
            distance: dist || 0,
            score: 0,
        };
        tree.score = this.scoreTree(tree);
        return tree;
    }

    findVerticalRuns(column) {
        const runs = [];
        let current = [];

        column.forEach((block) => {
            if (!current.length || block.y === current[current.length - 1].y + 1) {
                current.push(block);
                return;
            }
            if (current.length) runs.push(current);
            current = [block];
        });

        if (current.length) runs.push(current);
        return runs;
    }

    scoreTree(tree) {
        const logsPerHit = this.getLogsPerHit();
        const logCount = (tree.logBlocks || tree.blocks || []).length;
        const value = logCount * 8 + tree.lowerReachable * 4;
        const hitCost = tree.expectedHits * Math.max(2, 10 - Math.min(logsPerHit, 8));
        const distanceCost = tree.distanceFlat * 1.2 + Math.max(0, tree.trunk.maxY - Player.getY()) * 1.8;
        return value - hitCost - distanceCost;
    }

    getCachedBlock(x, y, z) {
        if (!this.blockCache)
            this.blockCache = new Map();
    
        const key = `${x},${y},${z}`;
    
        if (this.blockCache.has(key))
            return this.blockCache.get(key);
    
        // THIS was broken before
        const block = World.getBlockAt(x, y, z);
    
        this.blockCache.set(key, block);
    
        return block;
    }

    chooseBestTree(trees) {
        const eligible = trees.filter(
            (tree) =>
                tree.score > -120 &&
                !this.isTreeBlacklisted(tree) &&
                (!this.dontGoAfterBigTrees || !this.isBigTree(tree))
        );
        eligible.sort((a, b) => b.score - a.score);

        for (let i = 0; i < eligible.length; i++) {
            if (this.hasUsableTrunk(eligible[i])) return eligible[i];
        }
        return null;
    }

    isBigTree(tree) {
        return (Number(tree?.verticalSpan) || Number(tree?.trunkHeight) || 0) > BIG_TREE_MAX_VERTICAL_SPAN;
    }

    hasUsableTrunk(tree) {
        if (!tree?.logBlocks?.length && !tree?.trunkBlocks?.length) return false;
        const remaining = this.getRemainingTreeLogs(tree).length;
        return remaining >= Math.min(3, this.getMinFullTrunkLogs());
    }

    refreshCurrentTree() {
        if (!this.currentTree) return;
        this.refreshTreeLogsFromWorld(this.currentTree);
        this.currentTree.expectedHits = Math.max(
            1,
            Math.ceil((this.currentTree.logBlocks?.length || 0) / this.getLogsPerHit())
        );
        this.invalidateRemainingCache();
    }

    refreshTreeLogsFromWorld(tree, wide = false) {
        if (!tree?.trunk) return;

        const radius = wide ? TREE_LOG_RESCAN_RADIUS + 4 : TREE_LOG_RESCAN_RADIUS;
        const centerX = tree.trunk.x;
        const centerZ = tree.trunk.z;
        const minY = tree.trunk.minY - 2;
        const maxY = (tree.trunk.maxY || tree.trunk.minY) + 14;
        const byKey = new Map();

        (tree.logBlocks || tree.blocks || []).forEach((block) => {
            byKey.set(blockKey(block.x, block.y, block.z), block);
        });

        for (let y = minY; y <= maxY; y++) {
            for (let x = centerX - radius; x <= centerX + radius; x++) {
                for (let z = centerZ - radius; z <= centerZ + radius; z++) {
                    if (!this.isFigLogAt(x, y, z)) continue;
                    const key = blockKey(x, y, z);
                    if (!byKey.has(key)) byKey.set(key, { x, y, z });
                }
            }
        }

        const logBlocks = Array.from(byKey.values()).filter((block) => this.isFigLogAt(block.x, block.y, block.z));
        tree.logBlocks = logBlocks;
        tree.blocks = logBlocks;

        if (logBlocks.length) {
            let maxYSeen = tree.trunk.minY;
            logBlocks.forEach((block) => {
                if (block.y > maxYSeen) maxYSeen = block.y;
            });
            tree.trunk.maxY = maxYSeen;
            tree.trunkHeight = maxYSeen - tree.trunk.minY + 1;
        }
    }

    invalidateRemainingCache() {
        this._remainingLogsCache.clear();
        this._remainingLogsCacheTime = 0;
        this._miningProbeCache.clear();
        this._miningProbeFrameKey = null;
    }

    getMiningBlocks(tree) {
        return tree?.logBlocks || tree?.blocks || [];
    }

    getRemainingTreeLogs(tree) {
        return this.getRemainingTrunkLogs(tree);
    }

    isFigLogAt(x, y, z) {
        return this.isFigLogBlock(World.getBlockAt(x, y, z));
    }

    getRemainingTrunkLogs(tree) {
        if (!tree) return [];
        const key = treeKey(tree);
        const now = Date.now();

        if (now - this._remainingLogsCacheTime > 150) {
            this._remainingLogsCache.clear();
            this._remainingLogsCacheTime = now;
        }

        if (this._remainingLogsCache.has(key)) return this._remainingLogsCache.get(key);

        const result = this.getMiningBlocks(tree).filter((block) => this.isFigLogAt(block.x, block.y, block.z));
        this._remainingLogsCache.set(key, result);
        return result;
    }

    getPlayerEye() {
        const eye = Player.getPlayer()?.getEyePos?.();
        if (!eye) return null;
        return { x: eye.x, y: eye.y, z: eye.z };
    }

    isValidMiningAimPoint(point) {
        return !!this.getMiningAimCoords(point);
    }

    getMiningAimCoords(point) {
        if (!point) return null;
        const x = Array.isArray(point) ? point[0] : point.x ?? point.getX?.();
        const y = Array.isArray(point) ? point[1] : point.y ?? point.getY?.();
        const z = Array.isArray(point) ? point[2] : point.z ?? point.getZ?.();
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
        return [x, y, z];
    }

    resetMiningAimSmoothing() {
        this._miningSmoothAimPoint = null;
        this._miningSmoothAimKey = null;
        this._miningAimSeed = 0;
    }

    isPointWithinMiningReach(point, eye = this.getPlayerEye()) {
        if (!point || !eye) return false;
        const x = Array.isArray(point) ? point[0] : point.x;
        const y = Array.isArray(point) ? point[1] : point.y;
        const z = Array.isArray(point) ? point[2] : point.z;
        if (![x, y, z].every(Number.isFinite)) return false;
        return Math.hypot(x - eye.x, y - eye.y, z - eye.z) <= BLOCK_REACH + MINING_REACH_MARGIN;
    }

    getJumpMiningEye() {
        const eye = this.getPlayerEye();
        if (!eye) return null;
        return { x: eye.x, y: eye.y + JUMP_MINING_EYE_GAIN, z: eye.z };
    }

    beginMiningProbeFrame() {
        const eye = this.getPlayerEye();
        const key = eye
            ? `${Math.round(eye.x * 20)},${Math.round(eye.y * 20)},${Math.round(eye.z * 20)}`
            : 'no-eye';

        if (this._miningProbeFrameKey === key) return;

        this._miningProbeFrameKey = key;
        this._miningProbeCache.clear();
    }

    getMiningProbe(block, tree = this.currentTree) {
        if (!block) return null;

        const key = `${treeKey(tree)}|${blockKey(block.x, block.y, block.z)}`;
        const cached = this._miningProbeCache.get(key);
        if (cached) return cached;

        const exists = this.isFigLogAt(block.x, block.y, block.z);
        const positionMove = tree?.trunk ? this.needsMiningPositionMove(block, tree) : true;
        let standingAimPoint = null;
        let jumpAimPoint = null;
        let standingPitch = -Infinity;
        let jumpPitch = -Infinity;
        let canAimStanding = false;
        let canAimJumping = false;

        if (exists) {
            standingAimPoint = this.getMiningAimPoint(block);
            if (standingAimPoint) {
                standingPitch = MathUtils.calculateAbsoluteAngles(standingAimPoint).pitch;
                canAimStanding = standingPitch >= -MAX_MINING_PITCH;
            }

            if (!canAimStanding) {
                jumpAimPoint = this.getJumpMiningAimPoint(block);
                if (jumpAimPoint) {
                    jumpPitch = MathUtils.calculateAbsoluteAngles(jumpAimPoint).pitch;
                    canAimJumping = jumpPitch >= -MAX_JUMP_MINING_PITCH;
                }
            }
        }

        const needsJump = !canAimStanding && canAimJumping;
        const selectedAimPoint = needsJump ? jumpAimPoint : standingAimPoint;
        const selectedCanAim = needsJump ? canAimJumping : canAimStanding;
        const reachableStanding = exists && this.isBlockReachableStanding(block);
        const reachableJumping = exists && this.isBlockReachableJumping(block);
        const needsMove = positionMove || !selectedCanAim;
        const probe = {
            exists,
            standingAimPoint,
            jumpAimPoint,
            selectedAimPoint,
            standingPitch,
            jumpPitch,
            canAimStanding,
            canAimJumping,
            reachableStanding,
            reachableJumping,
            needsJump,
            positionMove,
            needsMove,
            canMineStanding: reachableStanding && !needsJump && canAimStanding && !needsMove,
            canMineJumping: reachableJumping && needsJump && canAimJumping && !needsMove,
        };

        this._miningProbeCache.set(key, probe);
        return probe;
    }

    getMiningAimPoint(block, eyeOverride = null) {
        if (!block || !this.isFigLogAt(block.x, block.y, block.z)) return null;

        const eye = eyeOverride || this.getPlayerEye();
        if (!eye) return null;
        const useCache = !eyeOverride;

        const key = blockKey(block.x, block.y, block.z);
        const now = Date.now();
        const cached = useCache ? this._miningAimCache.get(key) : null;
        if (cached && now - cached.time <= MINING_AIM_CACHE_MS) {
            const dx = eye.x - cached.eye.x;
            const dy = eye.y - cached.eye.y;
            const dz = eye.z - cached.eye.z;
            if (dx * dx + dy * dy + dz * dz <= MINING_AIM_EYE_MOVE_SQ) {
                return cached.point;
            }
        }

        let selected = null;
        for (let i = 0; i < MINING_AIM_OFFSETS.length; i++) {
            const offset = MINING_AIM_OFFSETS[i];
            const point = {
                x: block.x + offset[0],
                y: block.y + offset[1],
                z: block.z + offset[2],
            };

            if (!this.isPointWithinMiningReach(point, eye)) continue;
            if (!Raytrace.isLineClear(eye.x, eye.y, eye.z, point.x, point.y, point.z, block.x, block.y, block.z)) continue;

            selected = [point.x, point.y, point.z];
            break;
        }

        if (useCache) this._miningAimCache.set(key, { point: selected, eye, time: now });
        return selected;
    }

    getJumpMiningAimPoint(block) {
        return this.getMiningAimPoint(block, this.getJumpMiningEye());
    }

    getSmoothedMiningAimPoint(block, rawPoint) {
        if (!block) return null;
        const rawCoords = this.getMiningAimCoords(rawPoint);
        if (!rawCoords) {
            this.resetMiningAimSmoothing();
            return null;
        }

        const key = blockKey(block.x, block.y, block.z);
        if (this._miningSmoothAimKey !== key) {
            this._miningSmoothAimKey = key;
            this._miningSmoothAimPoint = rawCoords.slice();
            this._miningAimSeed = Math.random() * Math.PI * 2;
            return this._miningSmoothAimPoint;
        }

        const now = Date.now() / 1000;
        const driftX = Math.sin(now * 1.7 + this._miningAimSeed) * MINING_AIM_DRIFT;
        const driftY = Math.sin(now * 1.1 + this._miningAimSeed * 0.7) * MINING_AIM_DRIFT * 0.6;
        const driftZ = Math.cos(now * 1.45 + this._miningAimSeed) * MINING_AIM_DRIFT;
        const desired = [rawCoords[0] + driftX, rawCoords[1] + driftY, rawCoords[2] + driftZ];

        if (!this._miningSmoothAimPoint) {
            this._miningSmoothAimPoint = desired;
            return desired;
        }

        for (let i = 0; i < 3; i++) {
            this._miningSmoothAimPoint[i] += (desired[i] - this._miningSmoothAimPoint[i]) * MINING_AIM_SMOOTH_ALPHA;
        }

        return this._miningSmoothAimPoint;
    }

    updateNoAimStall(target, confirmedHit) {
        if (!target || confirmedHit) {
            this._miningNoAimTargetKey = null;
            this._miningNoAimSince = 0;
            return false;
        }

        const key = blockKey(target.x, target.y, target.z);
        if (this._miningNoAimTargetKey !== key) {
            this._miningNoAimTargetKey = key;
            this._miningNoAimSince = Date.now();
            return false;
        }

        return Date.now() - this._miningNoAimSince >= JUMP_MINING_STALL_MS;
    }

    updateMiningBreakProgress(remaining, isBreaking) {
        const count = remaining?.length || 0;
        const now = Date.now();

        if (!isBreaking) {
            this._miningBreakCount = count;
            this._miningBreakSince = 0;
            return false;
        }

        if (this._miningBreakCount !== count) {
            this._miningBreakCount = count;
            this._miningBreakSince = now;
            return false;
        }

        if (!this._miningBreakSince) {
            this._miningBreakSince = now;
            return false;
        }

        if (now - this._miningBreakSince < MINING_NO_BREAK_SKIP_MS) return false;

        this.blacklistCurrentTree(TREE_BLACKLIST_MS);
        this.finishTreeAttempt('no log broken');
        return true;
    }

    blacklistMiningTarget(target, durationMs = MINING_TARGET_BLACKLIST_MS) {
        if (!target) return;
        this._miningTargetBlacklist.set(blockKey(target.x, target.y, target.z), Date.now() + durationMs);
    }

    isMiningTargetBlacklisted(block) {
        if (!block) return false;
        const key = blockKey(block.x, block.y, block.z);
        const expires = this._miningTargetBlacklist.get(key);
        if (!expires) return false;
        if (expires > Date.now()) return true;
        this._miningTargetBlacklist.delete(key);
        return false;
    }

    isBlockReachable(block, extraReach = 1.5) {
        const dx = block.x + 0.5 - Player.getX();
        const dy = block.y + 0.5 - (Player.getY() + 1.62);
        const dz = block.z + 0.5 - Player.getZ();
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= BLOCK_REACH + extraReach;
    }

    isBlockReachableStanding(block) {
        return this.isBlockReachable(block, 1.2);
    }

    isBlockReachableJumping(block) {
        return this.isBlockReachable(block, 2.5);
    }

    getBlockAimAngles(block) {
        const aimPoint =
            this.getMiningAimCoords(block?.hitPoint) ||
            this.getMiningProbe(block)?.selectedAimPoint ||
            this.getMiningAimPoint(block) ||
            [block.x + 0.5, block.y + 0.55, block.z + 0.5];
        return MathUtils.calculateAbsoluteAngles(aimPoint);
    }

    needsJumpForBlock(block) {
        return !!this.getMiningProbe(block)?.needsJump;
    }

    canAimBlockFromHere(block, forJump) {
        const probe = this.getMiningProbe(block);
        return forJump ? !!probe?.canAimJumping : !!probe?.canAimStanding;
    }

    canMineBlockInPlace(block, forJump = false) {
        const probe = this.getMiningProbe(block);
        return forJump
            ? !!probe?.reachableJumping && !!probe?.canAimJumping
            : !!probe?.reachableStanding && !!probe?.canAimStanding;
    }

    needsMiningMovement(block, tree) {
        return this.getMiningProbe(block, tree)?.needsMove ?? true;
    }

    needsMiningPositionMove(block, tree) {
        if (!tree?.trunk) return true;

        const trunkFlat = Math.hypot(tree.trunk.x + 0.5 - Player.getX(), tree.trunk.z + 0.5 - Player.getZ());
        const blockFlat = Math.hypot(block.x + 0.5 - Player.getX(), block.z + 0.5 - Player.getZ());
        return trunkFlat > TRUNK_MINING_FLAT_DIST || blockFlat > BLOCK_MINING_FLAT_DIST;
    }

    canMineBlockStanding(block, tree) {
        return !!this.getMiningProbe(block, tree)?.canMineStanding;
    }

    canMineBlockJumping(block, tree) {
        return !!this.getMiningProbe(block, tree)?.canMineJumping;
    }

    getMiningStandCoords(tree, block = null) {
        const tx = tree.trunk.x + 0.5;
        const tz = tree.trunk.z + 0.5;
        let dx = block ? block.x + 0.5 - tx : Player.getX() - tx;
        let dz = block ? block.z + 0.5 - tz : Player.getZ() - tz;
        const len = Math.hypot(dx, dz);
        if (len < 0.4) {
            dx = Player.getX() - tx;
            dz = Player.getZ() - tz;
            const playerLen = Math.hypot(dx, dz);
            if (playerLen < 0.4) {
                dx = 1;
                dz = 0;
            } else {
                dx /= playerLen;
                dz /= playerLen;
            }
        } else {
            dx /= len;
            dz /= len;
        }
        const radius = block ? Math.max(1.35, Math.min(2.25, len + 1.05)) : 1.3;
        return { x: tx + dx * radius, z: tz + dz * radius };
    }

    isAtMiningStand(block, tree) {
        if (!block || !tree?.trunk) return false;
        const stand = this.getMiningStandCoords(tree, block);
        return Math.hypot(stand.x - Player.getX(), stand.z - Player.getZ()) <= MINING_STAND_ARRIVE_DIST;
    }

    resolveWalkGoalNear(x, z, preferredSupportY) {
        const baseX = Math.floor(Number(x));
        const baseZ = Math.floor(Number(z));
        const baseY = Math.floor(Number(preferredSupportY));
        if (![baseX, baseY, baseZ].every(Number.isFinite)) return null;

        const horizontalOffsets = [
            [0, 0],
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
        ].sort((a, b) => {
            const ax = baseX + a[0] + 0.5 - x;
            const az = baseZ + a[1] + 0.5 - z;
            const bx = baseX + b[0] + 0.5 - x;
            const bz = baseZ + b[1] + 0.5 - z;
            return ax * ax + az * az - (bx * bx + bz * bz);
        });
        const verticalOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];

        for (let i = 0; i < horizontalOffsets.length; i++) {
            const [dx, dz] = horizontalOffsets[i];
            const gx = baseX + dx;
            const gz = baseZ + dz;
            for (let j = 0; j < verticalOffsets.length; j++) {
                const gy = baseY + verticalOffsets[j];
                try {
                    if (Pathfinder.isWalkColumnValid(gx, gy, gz)) return [gx, gy, gz];
                } catch (e) {
                    return null;
                }
            }
        }

        return null;
    }

    getMiningStandKey(block, stand) {
        if (!block || !stand) return null;
        return `${blockKey(block.x, block.y, block.z)}>${Math.round(stand.x * 10)},${Math.round(stand.z * 10)}`;
    }

    clearMiningStandProgress() {
        this._miningStandMove = null;
    }

    resetMiningStandRecovery() {
        this._miningStandMove = null;
        this._miningStandPathKey = null;
        this._miningStandPathFailures = 0;
    }

    trackMiningStandProgress(block, stand, flat) {
        const key = this.getMiningStandKey(block, stand);
        if (!key || !Number.isFinite(flat)) return true;

        const now = Date.now();
        if (this._miningStandPathKey !== key) {
            this._miningStandPathKey = key;
            this._miningStandPathFailures = 0;
        }

        if (!this._miningStandMove || this._miningStandMove.key !== key) {
            this._miningStandMove = {
                key,
                bestFlat: flat,
                lastProgressAt: now,
            };
            return true;
        }

        if (flat < this._miningStandMove.bestFlat - MINING_STAND_PROGRESS_MARGIN) {
            this._miningStandMove.bestFlat = flat;
            this._miningStandMove.lastProgressAt = now;
            return true;
        }

        return now - this._miningStandMove.lastProgressAt < MINING_STAND_STUCK_MS;
    }

    tryPathToMiningStand(block, tree, stand) {
        if (this.isUpwarpMiningLocked(tree)) return false;
        if (!block || !tree?.trunk || !stand) return false;
        if (this.pathActive || Pathfinder.isPathing()) return true;
        if (this._miningStandPathFailures >= MINING_STAND_PATH_RETRY_LIMIT) return false;

        const preferredY = Math.floor(Player.getY()) - 1;
        const goal =
            this.resolveWalkGoalNear(stand.x, stand.z, preferredY) ||
            this.resolveWalkGoalNear(stand.x, stand.z, tree.trunk.minY);
        if (!goal) return false;

        this._miningStandPathFailures++;
        this.clearMiningStandProgress();

        const token = ++this.pathToken;
        this.pathActive = true;
        this.stopActiveControls();
        Rotations.stopRotation();
        this.status = 'Pathing to mining stand';

        Pathfinder.findPath([goal], (success) => {
            if (!this.enabled || token !== this.pathToken) return;
            this.pathActive = false;
            this.clearMiningStandProgress();

            if (success) {
                this.status = 'At mining stand';
                this.nextActionAt = 0;
                return;
            }

            this.blacklistCurrentTree(TREE_BLACKLIST_MS);
            this.abortTreeAndRescan('Mining stand path failed');
        });

        return true;
    }

    shouldJumpTowardMiningTarget(block) {
        if (!block) return false;
        const standingAimPoint = this.getMiningAimPoint(block);
        if (standingAimPoint) {
            const standingPitch = MathUtils.calculateAbsoluteAngles(standingAimPoint).pitch;
            if (standingPitch < -MAX_MINING_PITCH) return true;
            return false;
        }

        const eye = this.getPlayerEye();
        if (!eye) return block.y + 0.5 > Player.getY() + 1.8;

        return block.y + 0.5 > eye.y - 0.1;
    }

    getMiningNudgeCoords(block) {
        if (!block) return null;

        const targetX = block.x + 0.5;
        const targetZ = block.z + 0.5;
        const dx = targetX - Player.getX();
        const dz = targetZ - Player.getZ();
        const flat = Math.hypot(dx, dz);
        if (!Number.isFinite(flat) || flat <= MINING_OUT_OF_REACH_MIN_FLAT) return null;

        const step = Math.min(MINING_OUT_OF_REACH_NUDGE, Math.max(0.18, flat - MINING_OUT_OF_REACH_MIN_FLAT));
        return {
            x: Player.getX() + (dx / flat) * step,
            z: Player.getZ() + (dz / flat) * step,
        };
    }

    nudgeTowardMiningTarget(block, needsJump) {
        const shouldJump = !!needsJump || this.shouldJumpTowardMiningTarget(block);
        const nudge = this.getMiningNudgeCoords(block);

        if (nudge) {
            Keybind.setKeysForStraightLineCoords(nudge.x, Player.getY(), nudge.z, shouldJump, true);
        } else {
            Keybind.stopMovement();
        }

        this.syncMiningJump(shouldJump);
        this.clearMiningStandProgress();
        return true;
    }

    blockToTarget(block, probe = null) {
        return {
            x: block.x,
            y: block.y,
            z: block.z,
            hitPoint: probe?.selectedAimPoint || probe?.standingAimPoint || this.getMiningAimPoint(block),
        };
    }

    pickMiningTarget(blocks, tree) {
        const px = Player.getX();
        const pz = Player.getZ();
        const distSq = (block) => (block.x + 0.5 - px) ** 2 + (block.z + 0.5 - pz) ** 2;
        const sorted = blocks.filter((block) => !this.isMiningTargetBlacklisted(block)).sort((a, b) => {
            if (a.y !== b.y) return a.y - b.y;
            return distSq(a) - distSq(b);
        });

        const wrap = (block, probe, needsJump = probe?.needsJump, needsMove = probe?.needsMove) => ({
            target: this.blockToTarget(block, probe),
            needsJump: !!needsJump,
            needsMove: !!needsMove,
            probe,
        });

        if (this.isUpwarpMiningLocked(tree)) {
            return this.pickLockedUpwarpMiningTarget(sorted, wrap);
        }

        if (this.currentTargetBlock) {
            const t = this.currentTargetBlock;
            const stillThere = sorted.some((b) => b.x === t.x && b.y === t.y && b.z === t.z);
            if (stillThere && this.isFigLogAt(t.x, t.y, t.z)) {
                const probe = this.getMiningProbe(t, tree);
                if (probe?.canMineStanding) return wrap(t, probe, false, false);
                if (probe?.canMineJumping) return wrap(t, probe, true, false);
                if (probe?.selectedAimPoint && this.isBlockReachable(t, 3.2)) return wrap(t, probe, probe.needsJump, true);
                if (probe?.needsMove) return wrap(t, probe, probe.needsJump, true);
            }
        }

        let standing = null;
        let jumping = null;
        let reachableMove = null;
        let positionMove = null;

        for (let i = 0; i < sorted.length; i++) {
            const block = sorted[i];
            const probe = this.getMiningProbe(block, tree);
            if (!probe?.exists) continue;

            if (!standing && probe.canMineStanding) standing = wrap(block, probe, false, false);
            if (!jumping && probe.canMineJumping) jumping = wrap(block, probe, true, false);
            if (!reachableMove && this.isBlockReachable(block, 3.2) && (probe.selectedAimPoint || probe.positionMove)) {
                reachableMove = wrap(block, probe, probe.needsJump, true);
            }
            if (!positionMove && probe.positionMove) positionMove = wrap(block, probe, probe.needsJump, true);

            if (standing && jumping && reachableMove && positionMove) break;
        }

        return standing || jumping || reachableMove || positionMove || null;
    }

    pickLockedUpwarpMiningTarget(sorted, wrap) {
        const preferred = [];
        const protectedFallback = [];

        sorted.forEach((block) => {
            if (this.isUpwarpLockProtectedBlock(block)) protectedFallback.push(block);
            else preferred.push(block);
        });

        const pickFrom = (candidates) => {
            if (!candidates.length) return null;

            if (this.currentTargetBlock) {
                const t = this.currentTargetBlock;
                const stillThere = candidates.some((b) => b.x === t.x && b.y === t.y && b.z === t.z);
                if (stillThere && this.isFigLogAt(t.x, t.y, t.z)) {
                    const probe = this.getMiningProbe(t, this.currentTree);
                    if (probe?.reachableStanding && probe?.canAimStanding) return wrap(t, probe, false, false);
                    if (probe?.reachableJumping && probe?.canAimJumping) return wrap(t, probe, true, false);
                }
            }

            let standing = null;
            let jumping = null;
            for (let i = 0; i < candidates.length; i++) {
                const block = candidates[i];
                const probe = this.getMiningProbe(block, this.currentTree);
                if (!probe?.exists) continue;

                if (!standing && probe.reachableStanding && probe.canAimStanding) standing = wrap(block, probe, false, false);
                if (!jumping && probe.reachableJumping && probe.canAimJumping) jumping = wrap(block, probe, true, false);
                if (standing && jumping) break;
            }

            return standing || jumping || null;
        };

        return pickFrom(preferred) || pickFrom(protectedFallback);
    }

    syncMiningMovement(block, tree, needsJump = false, needsMove = false) {
        if (!block) {
            Keybind.stopMovement();
            this.syncMiningJump(false);
            this.clearMiningStandProgress();
            return true;
        }

        if (this.isUpwarpMiningLocked(tree)) {
            Keybind.stopMovement();
            this.syncMiningJump(!!needsJump);
            this.clearMiningStandProgress();
            return true;
        }

        const move = needsMove || (tree && this.needsMiningMovement(block, tree));
        const holdJump = !move && (needsJump || this.needsJumpForBlock(block));

        if (move && tree?.trunk) {
            const stand = this.getMiningStandCoords(tree, block);
            const flat = Math.hypot(stand.x - Player.getX(), stand.z - Player.getZ());
            if (flat <= MINING_STAND_ARRIVE_DIST) {
                return this.nudgeTowardMiningTarget(block, needsJump);
            }
            if (!this.trackMiningStandProgress(block, stand, flat)) {
                if (this.tryPathToMiningStand(block, tree, stand)) return false;
                this.blacklistCurrentTree(TREE_BLACKLIST_MS);
                this.abortTreeAndRescan('Mining stand blocked');
                return false;
            }
            const shouldJump = !!needsJump || this.shouldJumpTowardMiningTarget(block);
            Keybind.setKeysForStraightLineCoords(stand.x, Player.getY(), stand.z, shouldJump, true);
            this.syncMiningJump(shouldJump);
            return true;
        }

        if (holdJump) {
            if (tree?.trunk) {
                const stand = this.getMiningStandCoords(tree, block);
                const flat = Math.hypot(stand.x - Player.getX(), stand.z - Player.getZ());
                if (flat > 0.5) {
                    if (!this.trackMiningStandProgress(block, stand, flat)) {
                        if (this.tryPathToMiningStand(block, tree, stand)) return false;
                        this.blacklistCurrentTree(TREE_BLACKLIST_MS);
                        this.abortTreeAndRescan('Mining stand blocked');
                        return false;
                    }
                    Keybind.setKeysForStraightLineCoords(stand.x, Player.getY(), stand.z, true, true);
                } else {
                    this.nudgeTowardMiningTarget(block, true);
                }
            } else {
                Keybind.stopMovement();
                this.clearMiningStandProgress();
            }
            this.syncMiningJump(true);
            return true;
        }

        Keybind.stopMovement();
        this.syncMiningJump(false);
        this.clearMiningStandProgress();
        return true;
    }

    syncMiningJump(shouldHold) {
        if (this.holdingMiningJump !== shouldHold) {
            this.holdingMiningJump = shouldHold;
        }
        Keybind.setKey('space', shouldHold);
    }

    resetMiningSession() {
        this._miningStallCount = -1;
        this._miningStallSince = 0;
        this._miningBreakCount = -1;
        this._miningBreakSince = 0;
        this._miningHighAimSince = 0;
        this._miningAimCache.clear();
        this._miningProbeCache.clear();
        this._miningProbeFrameKey = null;
        this.resetMiningAimSmoothing();
        this.resetMiningRotationTracking();
        this._miningNoAimTargetKey = null;
        this._miningNoAimSince = 0;
        this._miningTargetBlacklist.clear();
        this.resetMiningStandRecovery();
        this.miningJumpPhase = false;
        this.treeGiftReceived = false;
        this._giftWaitSince = 0;
        this._treeEngaged = false;
        this._treeLogsPrimed = false;
        this._lastAxeThrowAt = 0;
        this.currentTargetBlock = null;
        this.invalidateRemainingCache();
    }

    getMiningRotationSpeed() {
        const profile = PACING[this.pacingMode] || PACING.Balanced;
        return profile.miningRotation || 2.8;
    }

    getEtherwarpTravelOptions() {
        const profile = PACING[this.pacingMode] || PACING.Balanced;
        return {
            preAimMs: profile.etherwarpPreAimMs ?? 55,
            postAimMs: profile.etherwarpPostAimMs ?? 30,
            hopDelayTicks: profile.etherwarpHopDelayTicks ?? 2,
            rotationSpeed: profile.etherwarpRotation ?? 0.95,
            minTurnMs: profile.etherwarpMinTurnMs ?? 45,
            degreesPerSecond: profile.etherwarpDegreesPerSecond ?? 340,
            msPerDegree: 1.5,
            aimThreshold: 0.85,
            pitchTurnScale: 0.78,
            aimTimeoutMs: 700,
        };
    }

    onChat(event) {
        if (!this.enabled) return;
        let text = '';
        try {
            text = cleanText(event?.message ?? ChatLib.getChatMessage(event, true));
        } catch (e) {
            return;
        }

        if (REGEN_TREE_MSG.test(text)) {
            if (!this.currentTree) return;
            this.handleRegeneratingTree();
            return;
        }

        if (TREE_GIFT_MSG.test(text)) {
            if (!this.currentTree || !this._treeEngaged) return;
            this.treeGiftReceived = true;
            this.finishTreeAttempt('Tree gift');
        }
    }

    handleRegeneratingTree() {
        this.blacklistCurrentTree(REGEN_TREE_BLACKLIST_MS);
        this.abortTreeAndRescan('Tree regenerating');
    }

    abortTreeAndRescan(status) {
        this.syncMiningJump(false);
        Keybind.setKey('leftclick', false);
        Rotations.stopRotation();
        this.pathToken++;
        this.pathActive = false;
        Pathfinder.resetPath();
        EtherwarpPathfinder.cancel(true);
        this.currentTree = null;
        this.currentTravel = null;
        this.currentTargetBlock = null;
        this.clearUpwarpMiningLock();
        this.resetMiningSession();
        this.needsFullScan = true;
        this.lastFullScanAt = 0;
        this._approachRetryCount = 0;
        this.transitionTo(STATES.SCANNING, status, 50);
    }

    isTreeApproachReady(tree) {
        if (!tree?.trunk) return false;
        if (Math.abs(Player.getY() - tree.trunk.minY) > 5) return false;

        const remaining = this.getRemainingTreeLogs(tree);
        if (!remaining.length) return this.isNearTreeBase(tree);

        const picked = this.pickMiningTarget(remaining, tree);
        const target = picked?.target || null;
        if (!target) return this.isNearTreeBase(tree);
        if (!this.needsMiningMovement(target, tree)) return true;

        const stand = this.getMiningStandCoords(tree, target);
        const flat = Math.hypot(stand.x - Player.getX(), stand.z - Player.getZ());
        return flat <= MINING_STAND_ARRIVE_DIST + TREE_APPROACH_STAND_MARGIN;
    }

    tryStartApproachRetry(status) {
        if (!this.currentTree || this._approachRetryCount >= TREE_APPROACH_RETRY_LIMIT) return false;

        const remaining = this.getRemainingTreeLogs(this.currentTree);
        if (!remaining.length) return false;

        const picked = this.pickMiningTarget(remaining, this.currentTree);
        const target = picked?.target || remaining[0];
        if (!target) return false;

        const stand = this.getMiningStandCoords(this.currentTree, target);
        const preferredY = Math.floor(Player.getY()) - 1;
        const goal =
            this.resolveWalkGoalNear(stand.x, stand.z, preferredY) ||
            this.resolveWalkGoalNear(stand.x, stand.z, this.currentTree.trunk.minY);
        if (!goal) return false;

        this._approachRetryCount++;
        this.currentTargetBlock = null;
        this.currentTravel = {
            mode: TRAVEL_MODES.WALK,
            goal,
            landing: { x: goal[0], y: goal[1], z: goal[2] },
            reason: 'approach retry',
        };
        this.transitionTo(STATES.TRAVELING, status, 80);
        return true;
    }

    isNearTreeBase(tree) {
        if (!tree?.trunk) return false;
        const dx = tree.trunk.x + 0.5 - Player.getX();
        const dz = tree.trunk.z + 0.5 - Player.getZ();
        const flatDistSq = dx * dx + dz * dz;
        return flatDistSq <= TRUNK_MINING_FLAT_DIST * TRUNK_MINING_FLAT_DIST && Math.abs(Player.getY() - tree.trunk.minY) <= 4;
    }

    getAxeSlot() {
        const axe = this.statsCollector.findBestAxe();
        if (axe) return axe.slot;
        const cached = Number(this.stats?.axeSlot);
        return cached >= 0 && cached <= 8 ? cached : -1;
    }

    getLogsPerHit() {
        return Math.max(1, Math.min(MAX_SWEEP_BLOCKS, Number(this.stats?.logsPerHit) || FALLBACK_LOGS_PER_HIT));
    }

    getMinFullTrunkLogs() {
        return Math.max(4, Math.min(9, 3 + Math.ceil(this.getLogsPerHit() / 2)));
    }

    getMinLogsForUpwarp() {
        return Math.max(2, Math.min(16, Number(this.minLogsForUpwarpSetting) || Math.ceil(this.getLogsPerHit() * 1.5)));
    }

    getRotationSpeed() {
        return (PACING[this.pacingMode] || PACING.Balanced).rotation;
    }

    blacklistCurrentTree(durationMs = TREE_BLACKLIST_MS) {
        if (!this.currentTree) return;
        this.blacklistedTrees.set(treeKey(this.currentTree), Date.now() + durationMs);
    }

    isTreeBlacklisted(tree) {
        const expires = this.blacklistedTrees.get(treeKey(tree));
        return !!expires && expires > Date.now();
    }

    blacklistLanding(goal) {
        const point = this.normalizeWalkGoal(goal);
        if (!point) return;
        this.blacklistedLandings.set(blockKey(point[0], point[1], point[2]), Date.now() + LANDING_BLACKLIST_MS);
    }

    isLandingBlacklisted(goal) {
        const point = this.normalizeWalkGoal(goal);
        if (!point) return false;
        const expires = this.blacklistedLandings.get(blockKey(point[0], point[1], point[2]));
        return !!expires && expires > Date.now();
    }

    pruneBlacklists() {
        const now = Date.now();
        for (const [key, expires] of this.blacklistedTrees.entries()) {
            if (expires <= now) this.blacklistedTrees.delete(key);
        }
        for (const [key, expires] of this.blacklistedLandings.entries()) {
            if (expires <= now) this.blacklistedLandings.delete(key);
        }
    }

    stopActiveControls() {
        Keybind.setKey('leftclick', false);
        Keybind.stopMovement();
        Keybind.setKey('shift', false);
        this.syncMiningJump(false);
    }

    handleWorldUnload() {
        this.pathToken++;
        this.pathActive = false;
        this.currentTree = null;
        this.currentTravel = null;
        this.lastScanTrees = [];
        this.needsFullScan = true;
        this._nearestScanMisses = 0;
        this.clearUpwarpMiningLock();
        this._approachRetryCount = 0;
        this.resetMiningStandRecovery();
        this.stopActiveControls();
        Rotations.stopRotation();
        Pathfinder.resetPath();
        EtherwarpPathfinder.cancel(true);
    }

    onEnable() {
        this.state = STATES.COLLECTING_STATS;
        this.status = 'Preparing stats';
        this.currentTree = null;
        this.currentTravel = null;
        this.pathActive = false;
        this.pathToken++;
        this.nextScanAt = 0;
        this.needsFullScan = true;
        this._nearestScanMisses = 0;
        this.blacklistedTrees.clear();
        this.blacklistedLandings.clear();
        this.clearUpwarpMiningLock();
        this._approachRetryCount = 0;
        this.resetMiningStandRecovery();

        this.stats = this.statsCollector.getStats();
        const ok = this.statsCollector.refreshIfNeeded(this.refreshStatsOnStart, (stats, refreshed) => {
            this.stats = stats;
            if (!this.enabled) return;
            if (!refreshed) this.message('&eUsing cached or conservative foraging stats fallback.');
        });
        if (!ok) this.message('&eUsing conservative foraging stats fallback.');
        this.transitionTo(STATES.SCANNING, this.statsCollector.isCollecting ? 'Ready, refreshing stats' : 'Ready', 200);
    }

    onDisable() {
        this.pathToken++;
        this.pathActive = false;
        this.currentTree = null;
        this.currentTravel = null;
        this.currentTargetBlock = null;
        this.lastScanTrees = [];
        this.needsFullScan = true;
        this._nearestScanMisses = 0;
        this.clearUpwarpMiningLock();
        this.state = STATES.WAITING;
        this.status = 'Disabled';
        this._approachRetryCount = 0;
        this.resetMiningSession();
        this.stopActiveControls();
        Keybind.unpressKeys();
        Rotations.stopRotation();
        Pathfinder.resetPath();
        EtherwarpPathfinder.cancel(true);
    }

    renderDebug() {
        if (!this.debug || !World.isLoaded()) return;

        const trees = this.currentTree ? [this.currentTree] : this.lastScanTrees;
        let renderedLogs = 0;

        treeLoop:
        for (let t = 0; t < trees.length; t++) {
            const tree = trees[t];
            const isTarget = this.currentTree && treeKey(this.currentTree) === treeKey(tree);
            const trunkColor = isTarget ? Render.Color(80, 255, 140, 120) : Render.Color(255, 220, 70, 80);
            const branchColor = isTarget ? Render.Color(120, 200, 255, 90) : Render.Color(255, 180, 60, 60);
            const trunkSet = new Set((tree.trunkBlocks || []).map((b) => blockKey(b.x, b.y, b.z)));
            const logs = tree.logBlocks || tree.blocks || tree.trunkBlocks || [];

            for (let i = 0; i < logs.length; i++) {
                if (renderedLogs >= DEBUG_RENDER_LOG_LIMIT) break treeLoop;
                const block = logs[i];
                const color = trunkSet.has(blockKey(block.x, block.y, block.z)) ? trunkColor : branchColor;
                Render.drawWireFrame(new Vec3d(block.x, block.y, block.z), color, 2, false);
                renderedLogs++;
            }
        }

        const landing = this.currentTravel?.landing;
        if (landing) {
            Render.drawStyledBox(new Vec3d(landing.x, landing.y, landing.z), Render.Color(80, 170, 255, 110), Render.Color(80, 170, 255, 220), 3, false);
        }
    }
}

export const ForagingB = new ForagingBot();
