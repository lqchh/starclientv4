import { ArmorStandEntity, BlockHitResult, Color, Direction, MCHand, Vec3d } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { MapUpdateS2C, PlayerInteractBlockC2S } from '../../utils/Packets';
import { ScheduleTask } from '../../utils/ScheduleTask';
import { Utils } from '../../utils/Utils';
import Render from '../../utils/render/Render';

const START_HINTS = ['the catacombs - floor', 'master mode catacombs - floor'];
const DUNGEON_START_COUNTDOWN = /\b(?:dungeon starts in|starting in)\s+[1-5]\s+seconds?\b/i;
const COMPLETION_HINTS = ['extra stats', 'team score:', 'dungeon complete'];
const PUZZLE_FAIL_HINTS = ['puzzle fail', 'failed the puzzle'];
const BLOOD_READY_HINTS = ['the blood room has been fully cleared', 'blood room cleared'];
const DUNGEON_READY_CHAT = /\bis now ready!?\s*$/i;
const DUNGEON_RUN_CHAT_HINTS = [
    'found this map when i first entered the dungeon',
    'the blood door has been opened',
    'starting in 1 second',
    'starting in 2 seconds',
    'starting in 3 seconds',
    'starting in 4 seconds',
    'starting in 5 seconds',
];
const DUNGEON_BOSS_CHAT_HINTS = ['[boss] the watcher:', '[boss] bonzo:', '[boss] scarf:', '[boss] the professor:', '[boss] thorn:', '[boss] livid:', '[boss] sadan:', '[boss] maxor:', '[boss] storm:', '[boss] goldor:', '[boss] necron:'];
const DUNGEON_CACHE_MS = 10 * 60 * 1000;
const DUNGEON_CONTEXT_CACHE_MS = 30000;
const DUNGEON_MAP_CACHE_MS = 45000;
const DUNGEON_COMPLETION_SUPPRESS_MS = 60000;
// Devonian Location.kt + Dungeons.kt scoreboard patterns (all floors: E, F1-F7, M1-M7).
const CATACOMBS_AREA = 'catacombs';
const CATACOMBS_FLOOR_REGEX = /(?:^|\s)(?:\u23e3\s*)?(?:the\s+)?catacombs\s*\((\w+)\)/i;
const CATACOMBS_MASTER_FLOOR_REGEX = /(?:^|\s)(?:\u23e3\s*)?master\s+mode\s+catacombs\s*\((\w+)\)/i;
const CATACOMBS_CLEARED_REGEX = /^cleared:\s*\d+%/i;
const CATACOMBS_TIME_REGEX = /time elapsed:/i;
const CATACOMBS_SECRETS_REGEX = /secrets found:/i;
const CATACOMBS_DEATHS_REGEX = /^team deaths:/i;
const CATACOMBS_CRYPTS_REGEX = /crypts:/i;
const CATACOMBS_SCOREBOARD_HINTS = [
    CATACOMBS_CLEARED_REGEX,
    CATACOMBS_TIME_REGEX,
    CATACOMBS_SECRETS_REGEX,
    CATACOMBS_DEATHS_REGEX,
    CATACOMBS_CRYPTS_REGEX,
    /score:/i,
    /milestone:/i,
];
const CATACOMBS_TAB_HINTS = [
    /^dungeon:\s*(?:the\s+)?catacombs\b/i,
    /^area:\s*(?:the\s+)?catacombs\b/i,
    /^area:\s*master\s+mode\s+catacombs\b/i,
    /(?:the\s+)?catacombs\s*\((?:e|f[1-7]|m[1-7])\)/i,
    /master\s+mode\s+catacombs\s*\((?:m[1-7]|f[1-7])\)/i,
];
const ROOM_CACHE_MS = 900;
const ROOM_TRANSFORM_CACHE_MS = 2500;
const GRID_ROOM_SIZE = 32;
const DUNGEON_GRID_START = -200;
const DUNGEON_ROOM_SIZE = 31;
const DUNGEON_ROOM_HALF = Math.floor(DUNGEON_ROOM_SIZE / 2);
const ROOM_FALLBACK_HORIZONTAL_RADIUS = 48;
const ROOM_FALLBACK_VERTICAL_RADIUS = 32;
const STAR_MARKERS = [0x2605, 0x2606, 0x2726, 0x2727, 0x2729, 0x272a, 0x272b, 0x272c, 0x272d, 0x272e, 0x272f, 0x2730];
const CLICK_RANGE_SQ = 36;
const AUTO_CLICK_COOLDOWN_MS = 900;
const MAX_BLOCK_SCAN_RADIUS = 16;
const ICE_FILL_SOLVE_BUDGET_MS = 250;
const WEIRDO_TRUTH_LINE = /^\[NPC\] ([A-Z][a-z]+): (?:The reward is(?: not in my chest!|n't in any of our chests\.)|My chest (?:doesn't have the reward\. We are all telling the truth\.|has the reward and I'm telling the truth!)|At least one of them is lying, and the reward is not in [A-Z][a-z]+'s chest!|Both of them are telling the truth\. Also, [A-Z][a-z]+ has the reward in their chest!)$/i;
const WEIRDO_NPC_RELS = [
    { x: 13, y: 69, z: 24 },
    { x: 15, y: 69, z: 25 },
    { x: 17, y: 69, z: 24 },
];

const WEIRDO_NAMES = [
    'Ardis',
    'Baxter',
    'Benson',
    'Carver',
    'Elmo',
    'Eveleth',
    'Hope',
    'Hugo',
    'Lino',
    'Luverne',
    'Madelia',
    'Marshall',
    'Melrose',
    'Montgomery',
    'Morris',
    'Ramsey',
    'Rose',
    'Victoria',
    'Virginia',
    'Willmar',
    'Winona',
];
const WEIRDO_NAME_SET = new Set(WEIRDO_NAMES.map((name) => name.toLowerCase()));

const QUIZ_ANSWERS = [
    { q: 'what is the status of the watcher', a: ['Stalker'] },
    { q: 'what is the status of bonzo', a: ['New Necromancer'] },
    { q: 'what is the status of scarf', a: ['Apprentice Necromancer'] },
    { q: 'what is the status of the professor', a: ['Professor'] },
    { q: 'what is the status of thorn', a: ['Shaman Necromancer'] },
    { q: 'what is the status of livid', a: ['Master Necromancer'] },
    { q: 'what is the status of sadan', a: ['Necromancer Lord'] },
    { q: 'what is the status of maxor, storm, goldor, and necron', a: ['The Wither Lords'] },
    { q: 'what is the status of maxor', a: ['The Wither Lords'] },
    { q: 'what is the status of storm', a: ['The Wither Lords'] },
    { q: 'what is the status of goldor', a: ['The Wither Lords'] },
    { q: 'what is the status of necron', a: ['The Wither Lords'] },
    { q: 'which brother is on the spiders den', a: ['Rick'] },
    { q: "what is the name of rick's brother", a: ['Pat'] },
    { q: 'what is the name of the vendor in the hub who sells stained glass', a: ['Wool Weaver'] },
    { q: 'what is the name of the person that upgrades pets', a: ['Kat'] },
    { q: 'what is the name of the lady of the nether', a: ['Elle'] },
    { q: 'which villager in the village gives you a rogue sword', a: ['Jamie'] },
    { q: 'how many unique minions are there', a: ['60 Minions', '60'] },
    { q: 'how many total fairy souls are there', a: ['267 Fairy Souls', '267'] },
    { q: 'how many fairy souls are there in spiders den', a: ['19 Fairy Souls', '19'] },
    { q: 'how many fairy souls are there in the end', a: ['12 Fairy Souls', '12'] },
    { q: 'how many fairy souls are there in the farming islands', a: ['20 Fairy Souls', '20'] },
    { q: 'how many fairy souls are there in crimson isle', a: ['29 Fairy Souls', '29'] },
    { q: 'how many fairy souls are there in the park', a: ['12 Fairy Souls', '12'] },
    { q: "how many fairy souls are there in jerry's workshop", a: ['5 Fairy Souls', '5'] },
    { q: 'how many fairy souls are there in hub', a: ['80 Fairy Souls', '80'] },
    { q: 'how many fairy souls are there in the hub', a: ['80 Fairy Souls', '80'] },
    { q: 'how many fairy souls are there in deep caverns', a: ['21 Fairy Souls', '21'] },
    { q: 'how many fairy souls are there in gold mine', a: ['12 Fairy Souls', '12'] },
    { q: 'how many fairy souls are there in dungeon hub', a: ['7 Fairy Souls', '7'] },
    { q: 'which of these enemies does not spawn in the spiders den', a: ['Zombie Spider', 'Cave Spider', 'Wither Skeleton', 'Dashing Spooder', 'Broodfather', 'Night Spider'] },
    { q: 'which of these monsters only spawns at night', a: ['Zombie Villager', 'Ghast'] },
    {
        q: 'which of these is not a dragon in the end',
        a: ['Zoomer Dragon', 'Weak Dragon', 'Stonk Dragon', 'Holy Dragon', 'Boomer Dragon', 'Booger Dragon', 'Older Dragon', 'Elder Dragon', 'Stable Dragon', 'Professor Dragon'],
    },
    { q: 'glass', a: ['Wool Weaver'] },
];
const QUIZ_ANSWER_BUTTONS = {
    A: { x: 20, y: 70, z: 6 },
    B: { x: 15, y: 70, z: 9 },
    C: { x: 10, y: 70, z: 6 },
};

const PUZZLE_GUIDES = [
    ['Creeper Beams', 'Use Skyblocker beam pairing from the live creeper base and target lanterns.'],
    ['Three Weirdos', 'Use Skyblocker exact truth lines and fixed NPC chest positions.'],
    ['Tic Tac Toe', 'Use Skyblocker row-major alpha-beta for the next move.'],
    ['Water Board', 'Use Skyblocker one-flow variants, door state, and timing data.'],
    ['Teleport Maze', 'Use Skyblocker pad memory and final unused-pad detection.'],
    ['Higher or Lower', 'Use Skyblocker blaze height detection for high-to-low or low-to-high.'],
    ['Boulder', 'Use Skyblocker A* over the current box grid and highlight the next button.'],
    ['Ice Fill', 'Use Skyblocker board-origin DFS paths for all three platforms.'],
    ['Ice Path', 'Use Skyblocker silverfish slide BFS to the exit lane.'],
    ['Quiz', 'Recognize Oruo questions, highlight the correct answer button, and optionally click it.'],
];

const SOLVER_NAMES = ['Three Weirdos', 'Higher or Lower', 'Quiz', 'Tic Tac Toe', 'Water Board', 'Teleport Maze', 'Boulder', 'Ice Fill', 'Ice Path', 'Creeper Beams'];
const OLD_DEFAULT_SOLVERS = ['Three Weirdos', 'Higher or Lower', 'Quiz'];
const DEFAULT_SOLVERS = SOLVER_NAMES.slice();
const BUTTON_IDS = ['button'];
const LEVER_IDS = ['lever'];
const ICE_IDS = ['ice'];
const TELEPORT_PAD_IDS = ['end_portal_frame', 'pressure_plate'];
const TTT_LINES = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];
const TTT_BUTTON_COMPS = [
    [7, 72, 17],
    [7, 72, 16],
    [7, 72, 15],
    [7, 71, 17],
    [7, 71, 16],
    [7, 71, 15],
    [7, 70, 17],
    [7, 70, 16],
    [7, 70, 15],
];
const TTT_FRAME_COMPS = [
    [8, 72, 17],
    [8, 72, 16],
    [8, 72, 15],
    [8, 71, 17],
    [8, 71, 16],
    [8, 71, 15],
    [8, 70, 17],
    [8, 70, 16],
    [8, 70, 15],
];
const TELEPORT_ROOM_CENTERS = [
    { x: 7, y: 68, z: 9 },
    { x: 23, y: 68, z: 9 },
    { x: 7, y: 68, z: 17 },
    { x: 23, y: 68, z: 17 },
    { x: 7, y: 68, z: 25 },
    { x: 15, y: 68, z: 25 },
    { x: 23, y: 68, z: 25 },
];
const TELEPORT_ROOM_TYPES = [
    ['ENTRANCE', 'barrier'],
    ['COAL', 'coal_ore'],
    ['IRON', 'iron_ore'],
    ['REDSTONE', 'redstone_ore'],
    ['LAPIS', 'lapis_ore'],
    ['GOLD', 'gold_ore'],
    ['DIAMOND', 'diamond_ore'],
    ['EMERALD', 'emerald_ore'],
];
const ICE_FILL_BOARD_ORIGINS = [
    { x: 16, y: 70, z: 9, size: 3 },
    { x: 17, y: 71, z: 16, size: 5 },
    { x: 18, y: 72, z: 25, size: 7 },
];
const CREEPER_COLORS = [
    [80, 180, 255],
    [120, 255, 100],
    [255, 230, 90],
    [255, 90, 255],
    [255, 120, 190],
];
const TELEPORT_PAD_COMPS = [
    [4, 6, 5, 7],
    [4, 12, 5, 11],
    [4, 14, 5, 15],
    [4, 20, 5, 19],
    [4, 22, 5, 23],
    [4, 28, 5, 27],
    [10, 6, 9, 7],
    [10, 12, 9, 11],
    [10, 14, 9, 15],
    [10, 20, 9, 19],
    [10, 22, 9, 23],
    [10, 28, 9, 27],
    [12, 22, 13, 23],
    [12, 28, 13, 27],
    [18, 22, 17, 23],
    [18, 28, 17, 27],
    [20, 6, 21, 7],
    [20, 12, 21, 11],
    [20, 14, 21, 15],
    [20, 20, 21, 19],
    [20, 22, 21, 23],
    [20, 28, 21, 27],
    [26, 6, 25, 7],
    [26, 12, 25, 11],
    [26, 14, 25, 15],
    [26, 20, 25, 19],
    [26, 22, 25, 23],
    [26, 28, 25, 27],
    [15, 12, 14, 11, true, false],
    [15, 14, 16, 15, true, true],
];
const WATER_LEVERS = [
    ['Quartz', 20, 61, 20],
    ['Gold', 20, 61, 15],
    ['Coal', 20, 61, 10],
    ['Diamond', 10, 61, 20],
    ['Emerald', 10, 61, 15],
    ['Clay', 10, 61, 10],
];
const WATER_BOARD_MIN_X = 6;
const WATER_BOARD_MAX_X = 24;
const WATER_BOARD_MIN_Y = 58;
const WATER_BOARD_MAX_Y = 81;
const WATER_BOARD_Z = 26;
const WATER_ENTRANCE = { x: 15, y: 78, z: 26 };
const WATER_LEVER_TYPES = {
    coal: {
        label: 'Coal',
        block: 'coal_block',
        pos: { x: 20, y: 61, z: 10 },
        initial: [{ x: 0, y: -2, z: 0 }, { x: 2, y: -1, z: 1 }, null, { x: 5, y: -1, z: 0 }],
        color: [255, 90, 90],
    },
    gold: {
        label: 'Gold',
        block: 'gold_block',
        pos: { x: 20, y: 61, z: 15 },
        initial: [{ x: 1, y: -1, z: 0 }, { x: 3, y: -2, z: 0 }, { x: -4, y: -1, z: 1 }, { x: 1, y: 0, z: 0 }],
        color: [255, 220, 70],
    },
    quartz: {
        label: 'Quartz',
        block: 'quartz_block',
        pos: { x: 20, y: 61, z: 20 },
        initial: [{ x: 1, y: -4, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 1 }],
        color: [210, 210, 210],
    },
    diamond: {
        label: 'Diamond',
        block: 'diamond_block',
        pos: { x: 10, y: 61, z: 20 },
        initial: [{ x: 0, y: -5, z: 1 }, { x: -2, y: -1, z: 0 }, { x: -1, y: 0, z: 1 }, { x: -3, y: -4, z: 1 }],
        color: [80, 220, 255],
    },
    emerald: {
        label: 'Emerald',
        block: 'emerald_block',
        pos: { x: 10, y: 61, z: 15 },
        initial: [{ x: -1, y: -10, z: 1 }, { x: 1, y: 0, z: 1 }, { x: -6, y: 0, z: 0 }, { x: 1, y: -4, z: 0 }],
        color: [80, 255, 120],
    },
    terracotta: {
        label: 'Terracotta',
        block: 'terracotta',
        pos: { x: 10, y: 61, z: 10 },
        initial: [{ x: -1, y: -1, z: 1 }, { x: 0, y: -3, z: 1 }, null, { x: -4, y: -5, z: 1 }],
        color: [255, 150, 60],
    },
    water: {
        label: 'Water',
        block: 'lava',
        pos: { x: 15, y: 60, z: 5 },
        initial: null,
        color: [80, 170, 255],
    },
};
const WATER_LEVER_ORDER = ['coal', 'gold', 'quartz', 'diamond', 'emerald', 'terracotta', 'water'];
const WATER_SOLUTIONS = loadWaterSolutions();

function loadWaterSolutions() {
    if (typeof FileLib === 'undefined') return {};

    const candidates = [
        ['V5-main', 'assets/watertimes.json'],
        ['V5', 'assets/watertimes.json'],
    ];

    for (let i = 0; i < candidates.length; i++) {
        const root = candidates[i][0];
        const path = candidates[i][1];
        try {
            const raw = FileLib.read(root, path);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
    }

    return {};
}
class DungeonUtils extends ModuleBase {
    constructor() {
        super({
            name: 'DungeonUtils',
            subcategory: 'Dungeons',
            description: 'Background dungeon ESP and active Catacombs puzzle solvers.',
            tooltip: 'Configurable dungeon ESP, puzzle highlights, and safe solved-target clicks.',
            theme: '#b85cff',
            showEnabledToggle: false,
        });

        this.tickCounter = 0;
        this.nextWorldScanAt = 0;
        this.nextLightSolverScanAt = 0;
        this.lastRoomKey = null;
        this.dungeonSeenUntil = 0;
        this.dungeonActive = false;
        this.inCatacombsRun = false;
        this.lastCompletionMessage = 0;
        this.completedAt = 0;
        this.lastStartMessage = 0;
        this.lastAutoClick = 0;
        this.lastMapPacket = 0;
        this.mapSignals = 0;
        this.contextCacheUntil = 0;
        this.contextCacheReason = null;

        this.alertDungeonStart = true;
        this.alertPuzzleFails = true;
        this.alertBloodReady = true;
        this.autoGG = false;
        this.autoGGDelayTicks = 20;

        this.puzzleHighlights = true;
        this.autoInteract = false;
        this.experimentalWorldScanners = true;
        this.worldScannerDelaySeconds = 3;
        this.enabledSolvers = new Set(DEFAULT_SOLVERS);
        this.blazeOrder = 'Auto';

        this.starredMobEsp = true;
        this.starredMobRoomOnly = true;
        this.starredMobLabels = true;
        this.starredMobRange = 72;
        this.starredMobThickness = 4;
        this.starredMobColor = Render.Color(255, 210, 60, 255);

        this.activePuzzle = 'None';
        this.solverHint = 'No active puzzle hint';
        this.roomBounds = null;
        this.roomBoundsAt = 0;
        this.roomBoundsSource = 'none';
        this.roomTransform = null;
        this.roomTransformKey = null;
        this.roomTransformAt = 0;
        this.starredMobs = [];
        this.renderTargets = [];

        this.weirdoStatements = new Map();
        this.weirdoChest = null;
        this.weirdoSolvedAt = 0;
        this.quizAnswers = [];
        this.quizTargets = [];
        this.quizCurrentAnswerLetter = null;
        this.quizOptionAnswers = new Map();
        this.blazeTarget = null;
        this.blazeTargetHealth = null;
        this.blazeNextTarget = null;
        this.blazeNextHealth = null;
        this.ticTacToeTarget = null;
        this.waterTargets = [];
        this.waterTransformKey = null;
        this.waterTransform = null;
        this.waterVariant = 0;
        this.waterDoors = null;
        this.waterInitialDoors = null;
        this.waterSolution = null;
        this.waterStartMillis = 0;
        this.waterFinished = false;
        this.teleportPads = [];
        this.teleportPadsKey = null;
        this.teleportLastPos = null;
        this.teleportLastPad = null;
        this.teleportKnownPads = new Map();
        this.teleportFinalPad = null;
        this.teleportTransform = null;
        this.boulderTarget = null;
        this.iceFillPath = [];
        this.icePathTarget = null;
        this.creeperBeamTargets = [];

        this.addConfig();

        this.on('chat', (event) => this.safeRun('chat', () => this.handleChat(event)));
        this.on('tick', () => this.safeRun('tick', () => this.tick()));
        this.on('playerInteract', (action, pos) => this.safeRun('player interact', () => this.handlePlayerInteract(action, pos)));
        this.on('postRenderWorld', () => this.safeRun('render', () => this.render()));
        this.on('packetReceived', (packet) => this.safeRun('map packet', () => this.handleMapUpdate(packet))).setFilteredClass(MapUpdateS2C);
        this.on('worldUnload', () => this.safeRun('world unload', () => this.clearDungeonSession()));
        this.on('worldLoad', () => this.safeRun('world load', () => Utils.resetLocationCache?.()));

        this.toggle(true, true, 'system');
    }

    addConfig() {
        this.addSeparator('Dungeon State', true);
        this.addToggle('Start Alert', (value) => (this.alertDungeonStart = !!value), 'Shows a message when a dungeon starts.', true);
        this.addToggle('Puzzle Fail Alert', (value) => (this.alertPuzzleFails = !!value), 'Shows puzzle fail alerts.', true);
        this.addToggle('Blood Ready Alert', (value) => (this.alertBloodReady = !!value), 'Shows blood ready alerts.', true);
        this.addToggle('Auto GG', (value) => (this.autoGG = !!value), 'Sends gg shortly after dungeon completion.', false);
        this.addSlider('Auto GG Delay', 0, 60, this.autoGGDelayTicks, (value) => (this.autoGGDelayTicks = Math.round(value)), 'Delay in ticks.');

        this.addSeparator('Starred Mob ESP', true);
        this.addToggle('Starred Mob ESP', (value) => (this.starredMobEsp = !!value), 'Highlights starred dungeon mobs through walls.', true);
        this.addToggle('Current Room Only', (value) => (this.starredMobRoomOnly = !!value), 'Only show starred mobs in your current room.', true);
        this.addToggle('Starred Mob Labels', (value) => (this.starredMobLabels = !!value), 'Shows labels over starred mobs.', true);
        this.addSlider('Starred Mob Range', 16, 128, this.starredMobRange, (value) => (this.starredMobRange = Math.round(value)), 'Maximum starred mob ESP range.');
        this.addSlider('Starred Mob Line Width', 1, 8, this.starredMobThickness, (value) => (this.starredMobThickness = Math.round(value)), 'ESP outline thickness.');
        this.addColorPicker(
            'Starred Mob Color',
            Color.YELLOW,
            (color) => {
                this.starredMobColor = Render.Color(color.getRed(), color.getGreen(), color.getBlue(), color.getAlpha());
            },
            'ESP box and label color.'
        );

        this.addSeparator('Puzzle Solvers', true);
        this.addToggle('Puzzle Highlights', (value) => (this.puzzleHighlights = !!value), 'Shows puzzle highlights and labels.', true);
        this.addToggle('Auto Interact', (value) => (this.autoInteract = !!value), 'Clicks only unique, confident solved puzzle targets.', false);
        this.addToggle(
            'Experimental World Scanners',
            (value) => {
                this.experimentalWorldScanners = !!value;
            },
            'Uses the faster scan interval for puzzles that still need world reads. Turn off for slower throttled scans.',
            true
        );
        this.addSlider(
            'World Scanner Delay',
            2,
            10,
            this.worldScannerDelaySeconds,
            (value) => (this.worldScannerDelaySeconds = Math.max(2, Math.round(value))),
            'Seconds between expensive puzzle room scans.'
        );
        this.addMultiToggle(
            'Enabled Solvers',
            SOLVER_NAMES,
            false,
            (options) => {
                this.enabledSolvers = this.normalizeEnabledSolvers(options);
            },
            'Controls which active Catacombs puzzle solvers run.',
            DEFAULT_SOLVERS
        );
        this.addMultiToggle(
            'Blaze Order',
            ['Auto', 'Low -> High', 'High -> Low'],
            true,
            (options) => {
                this.blazeOrder = (options || []).find((option) => option.enabled)?.name || 'Auto';
            },
            'Kept for compatibility; the solver now follows Skyblocker room-height detection.',
            'Auto'
        );
        this.addButton('Print Puzzle Guides', () => this.printPuzzleGuides(), 'Prints concise guides for supported active puzzles.');
    }

    safeRun(label, callback) {
        try {
            return callback();
        } catch (e) {
            console.error(`V5 DungeonUtils ${label} error: ` + e + (e && e.stack ? e.stack : ''));
        }
        return null;
    }

    handleChat(event) {
        if (!this.enabled || !event?.message) return;

        const clean = this.cleanText(event.message);
        const lower = clean.toLowerCase();

        if (this.isDungeonCompletion(lower)) {
            this.handleCompletion();
            return;
        }

        if (this.isDungeonStart(lower)) {
            this.completedAt = 0;
            this.setDungeonActive('dungeon start');
            if (Date.now() - this.lastStartMessage > 30000) {
                this.resetRun();
                this.lastStartMessage = Date.now();
                if (this.alertDungeonStart) this.message('&dDungeon started.');
            }
            return;
        }

        if (this.isDungeonReadyChat(clean, lower)) {
            this.setDungeonActive('party ready');
            return;
        }

        if (this.isDungeonRunChat(lower)) {
            this.setDungeonActive('run chat');
            if (lower.includes('found this map when i first entered the dungeon')) this.resetRun();
        }

        if (this.isDungeonSignal(lower)) this.setDungeonActive('chat signal');
        if (this.solverEnabled('Three Weirdos')) this.handleThreeWeirdosChat(clean);
        if (this.solverEnabled('Quiz')) this.handleQuizChat(clean, lower);

        if (this.alertPuzzleFails && PUZZLE_FAIL_HINTS.some((hint) => lower.includes(hint))) {
            this.message('&cPuzzle failed.');
            return;
        }

        if (this.alertBloodReady && BLOOD_READY_HINTS.some((hint) => lower.includes(hint))) {
            this.message('&cBlood ready.');
            return;
        }

        if (lower.includes('lost tic tac toe')) this.setSolverHint('Tic Tac Toe', 'Wrong move. Re-scan the board before clicking again.');
        if (lower.includes('killed a blaze in the wrong order')) this.setSolverHint('Higher or Lower', 'Wrong blaze order. Recheck low-to-high vs high-to-low.');
        if (lower.includes('pushed the silverfish into a trap')) this.setSolverHint('Ice Path', 'Reset route; only push in straight lines to a safe stop.');

    }

    handleMapUpdate() {
        if (Date.now() - this.completedAt < DUNGEON_COMPLETION_SUPPRESS_MS) return;
        this.setDungeonActive('dungeon map', DUNGEON_MAP_CACHE_MS);
        this.lastMapPacket = Date.now();
        this.mapSignals++;
    }

    handlePlayerInteract(action, pos) {
        if (!this.enabled || !this.solverEnabled('Water Board')) return;
        if (!action?.toString?.().includes('UseBlock') || !pos) return;
        this.consumeWaterLeverClick({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
    }

    tick() {
        if (!this.enabled) return;
        this.tickCounter++;

        if (!World.isLoaded()) {
            this.clearRuntimeTargets();
            return;
        }

        const contextReason = this.getCatacombsContextReason();
        if (contextReason) this.setDungeonActive(contextReason, DUNGEON_CONTEXT_CACHE_MS);

        if (!this.isInDungeon()) {
            if (!this.inCatacombsRun) this.clearRuntimeTargets();
            return;
        }

        this.updateRoomScanState();
        if (this.tickCounter % 10 === 0) this.safeRun('room bounds', () => this.updateCurrentRoomBounds());
        if (this.tickCounter % 4 === 0 && this.starredMobEsp) this.safeRun('starred mobs', () => this.updateStarredMobs());
        if (this.tickCounter % 2 === 0) this.safeRun('solvers', () => this.updateSolvers());
        this.safeRun('teleport learning', () => this.updateTeleportLearning());
        this.safeRun('waterboard timing', () => this.updateWaterBoardTiming());
    }

    updateSolvers() {
        if (!this.puzzleHighlights) {
            this.clearSolverTargets();
            return;
        }

        const lightJobs = [
            ['Higher or Lower', () => this.updateBlazeSolver(), () => {
                this.blazeTarget = null;
                this.blazeTargetHealth = null;
                this.blazeNextTarget = null;
                this.blazeNextHealth = null;
            }],
            ['Quiz', () => this.updateQuizTargets(), () => (this.quizTargets = [])],
            ['Tic Tac Toe', () => this.updateTicTacToeSolver(), () => (this.ticTacToeTarget = null)],
            ['Ice Path', () => this.updateIcePathSolver(), () => (this.icePathTarget = null)],
        ];
        const worldScanJobs = [
            ['Teleport Maze', () => this.updateTeleportMazeSolver(), () => {
                this.teleportPads = [];
                this.teleportPadsKey = null;
                this.teleportKnownPads.clear();
                this.teleportFinalPad = null;
                this.teleportTransform = null;
            }],
            ['Boulder', () => this.updateBoulderSolver(), () => (this.boulderTarget = null)],
            ['Creeper Beams', () => this.updateCreeperBeamsSolver(), () => (this.creeperBeamTargets = [])],
            ['Water Board', () => this.updateWaterBoardSolver(), () => this.resetWaterBoardState()],
            ['Ice Fill', () => this.updateIceFillSolver(), () => (this.iceFillPath = [])],
        ];

        if (Date.now() >= this.nextLightSolverScanAt) {
            lightJobs.forEach((job) => {
                if (this.solverEnabled(job[0])) this.safeRun(`${job[0]} solver`, job[1]);
                else job[2]();
            });
            this.nextLightSolverScanAt = Date.now() + 250;
        }

        worldScanJobs.forEach((job) => {
            if (!this.solverEnabled(job[0])) job[2]();
        });

        const enabledWorldScanJobs = worldScanJobs.filter((job) => this.solverEnabled(job[0]));
        if (!enabledWorldScanJobs.length) {
            this.clearHeavyScanTargets();
        } else if (Date.now() >= this.nextWorldScanAt) {
            enabledWorldScanJobs.forEach((job) => this.safeRun(`${job[0]} solver`, job[1]));
            const delaySeconds = this.experimentalWorldScanners ? this.worldScannerDelaySeconds : Math.max(this.worldScannerDelaySeconds, 6);
            this.nextWorldScanAt = Date.now() + delaySeconds * 1000;
        }

        if (Date.now() - this.weirdoSolvedAt > 15000) this.weirdoChest = null;
    }

    updateRoomScanState() {
        const roomKey = this.getDungeonRoomKey(this.getPlayerPos());
        if (roomKey === this.lastRoomKey) return;

        this.lastRoomKey = roomKey;
        this.roomBoundsAt = 0;
        this.roomTransform = null;
        this.roomTransformKey = null;
        this.roomTransformAt = 0;
        this.nextWorldScanAt = 0;
        this.nextLightSolverScanAt = 0;
        this.clearWorldScanTargets();
    }

    render() {
        if (!this.enabled || !World.isLoaded()) return;
        if (!this.isInDungeon() && !this.hasRenderableTargets()) return;

        if (this.starredMobEsp) this.safeRun('render starred mobs', () => this.renderStarredMobs());
        if (!this.puzzleHighlights) return;

        this.safeRun('render three weirdos', () => this.renderThreeWeirdos());
        this.safeRun('render blaze', () => this.renderBlaze());
        this.safeRun('render quiz', () => this.renderQuiz());
        this.safeRun('render tic tac toe', () => this.renderTicTacToe());
        this.safeRun('render water board', () => this.renderWaterBoard());
        this.safeRun('render teleport maze', () => this.renderTeleportMaze());
        this.safeRun('render boulder', () => this.renderBoulder());
        this.safeRun('render ice fill', () => this.renderIceFill());
        this.safeRun('render ice path', () => this.renderIcePath());
        this.safeRun('render creeper beams', () => this.renderCreeperBeams());
    }

    isDungeonStart(lower) {
        return START_HINTS.some((hint) => lower.includes(hint)) || DUNGEON_START_COUNTDOWN.test(lower);
    }

    isDungeonReadyChat(clean, lower) {
        return DUNGEON_READY_CHAT.test(clean) || DUNGEON_READY_CHAT.test(lower) || lower.includes('is now ready');
    }

    isDungeonRunChat(lower) {
        return DUNGEON_RUN_CHAT_HINTS.some((hint) => lower.includes(hint)) || DUNGEON_BOSS_CHAT_HINTS.some((hint) => lower.includes(hint));
    }

    isDungeonSignal(lower) {
        return (
            this.isDungeonStart(lower) ||
            this.isDungeonReadyChat('', lower) ||
            this.isDungeonRunChat(lower) ||
            lower.includes('secrets found') ||
            lower.includes('dungeon cleared') ||
            lower.includes('blessing of') ||
            lower.includes('[npc] oruo') ||
            lower.includes('[npc] mort:') ||
            lower.includes('blood room') ||
            lower.includes('puzzle') ||
            this.isWeirdoNpcLine(lower)
        );
    }

    isDungeonCompletion(lower) {
        return COMPLETION_HINTS.some((hint) => lower.includes(hint));
    }

    isInDungeon() {
        if (Date.now() - this.completedAt < DUNGEON_COMPLETION_SUPPRESS_MS) return false;
        if (this.inCatacombsRun || this.dungeonActive) return true;
        if (Date.now() < this.dungeonSeenUntil) return true;
        if (Date.now() - this.lastMapPacket < DUNGEON_MAP_CACHE_MS) return true;

        const contextReason = this.getCatacombsContextReason();
        if (contextReason) {
            this.setDungeonActive(contextReason, DUNGEON_CONTEXT_CACHE_MS);
            return true;
        }

        return false;
    }

    getSkyblockArea() {
        return this.cleanText(Utils.area?.() || '').toLowerCase();
    }

    isInCatacombsArea() {
        const area = this.getSkyblockArea();
        return area === CATACOMBS_AREA || area === `the ${CATACOMBS_AREA}` || area.includes('catacombs');
    }

    getCatacombsFloor() {
        try {
            const subFloor = this.extractCatacombsFloor(Utils.subArea?.() || '');
            if (subFloor) return subFloor;

            for (const raw of this.getScoreboardTexts()) {
                const floor = this.extractCatacombsFloor(raw);
                if (floor) return floor;
            }

            for (const raw of this.getTabListTexts()) {
                const floor = this.extractCatacombsFloor(raw);
                if (floor) return floor;
            }
        } catch (e) {}
        return null;
    }

    extractCatacombsFloor(text) {
        const line = this.cleanText(text);
        const match = line.match(CATACOMBS_MASTER_FLOOR_REGEX) || line.match(CATACOMBS_FLOOR_REGEX);
        return match?.[1] ? match[1].toUpperCase() : null;
    }

    hasCatacombsRunScoreboard() {
        try {
            return this.getScoreboardTexts().some((raw) => this.hasCatacombsRunScoreboardFromLine(String(raw || '').trim()));
        } catch (e) {
            return false;
        }
    }

    isInCatacombsContext() {
        return !!this.getCatacombsContextReason();
    }

    getCatacombsContextReason() {
        const now = Date.now();
        if (now < this.contextCacheUntil) return this.contextCacheReason;

        this.contextCacheReason = this.readCatacombsContextReason();
        this.contextCacheUntil = now + (this.contextCacheReason ? 250 : 1000);
        return this.contextCacheReason;
    }

    readCatacombsContextReason() {
        if (Date.now() - this.completedAt < DUNGEON_COMPLETION_SUPPRESS_MS) return null;
        if (this.getCatacombsFloor()) return 'catacombs floor';
        if (this.hasDungeonTabList()) return 'catacombs tab';
        if (this.hasCatacombsRunScoreboard()) return 'catacombs scoreboard';
        if (this.hasDungeonScoreboard()) return 'dungeon scoreboard';
        if (this.isInCatacombsArea()) return 'catacombs area';
        if (this.hasDungeonEntityHints()) return 'dungeon entity';
        return null;
    }

    setDungeonActive(reason, duration = DUNGEON_CACHE_MS) {
        if (reason !== 'dungeon start' && Date.now() - this.completedAt < DUNGEON_COMPLETION_SUPPRESS_MS) return;
        const wasActive = this.inCatacombsRun || this.dungeonActive || Date.now() < this.dungeonSeenUntil;
        this.inCatacombsRun = true;
        this.dungeonActive = true;
        this.markDungeonSeen(duration);
        if (!wasActive || reason === 'dungeon start') this.nextWorldScanAt = 0;
    }

    clearDungeonSession() {
        this.inCatacombsRun = false;
        this.dungeonActive = false;
        this.dungeonSeenUntil = 0;
        this.lastMapPacket = 0;
        this.mapSignals = 0;
        this.completedAt = 0;
        this.lastStartMessage = 0;
        this.contextCacheUntil = 0;
        this.contextCacheReason = null;
        Utils.resetLocationCache?.();
        this.resetRun();
    }

    hasDungeonTabList() {
        try {
            return this.getTabListTexts().some((clean) => this.matchesDungeonTabText(clean));
        } catch (e) {
            return false;
        }
    }

    matchesDungeonTabText(clean) {
        const line = this.cleanText(clean);
        if (!line) return false;
        if (CATACOMBS_TAB_HINTS.some((regex) => regex.test(line))) return true;

        const lower = line.toLowerCase();
        return (lower.startsWith('dungeon:') || lower.startsWith('area:')) && lower.includes('catacombs');
    }

    hasDungeonScoreboard() {
        try {
            return this.getScoreboardTexts().some((clean) => this.matchesDungeonScoreboardText(clean));
        } catch (e) {
            return false;
        }
    }

    matchesDungeonScoreboardText(clean) {
        const line = this.cleanText(clean);
        if (CATACOMBS_FLOOR_REGEX.test(line) || CATACOMBS_MASTER_FLOOR_REGEX.test(line)) return true;
        if (this.hasCatacombsRunScoreboardFromLine(line)) return true;

        const lower = line.toLowerCase();
        return (
            lower.includes('the catacombs') ||
            lower.includes('master mode catacombs') ||
            lower.includes('secrets found') ||
            lower.includes('team deaths') ||
            lower.includes('time elapsed')
        );
    }

    hasCatacombsRunScoreboardFromLine(line) {
        const clean = this.cleanText(line);
        return CATACOMBS_SCOREBOARD_HINTS.some((regex) => regex.test(clean));
    }

    getScoreboardTexts() {
        const texts = this.getScoreboardLinesText();

        try {
            const title = Scoreboard.getTitle?.();
            if (title) {
                const titleText = this.cleanText(title);
                if (titleText) texts.push(titleText);
            }
        } catch (e) {}

        return texts;
    }

    getScoreboardLinesText() {
        const lines = Scoreboard.getLines?.() || [];
        return lines
            .map((line) => {
                try {
                    if (typeof line?.getName === 'function') return this.cleanText(line.getName());
                } catch (e) {}
                return this.cleanText(line);
            })
            .filter(Boolean);
    }

    getTabListTexts() {
        const texts = [];

        try {
            const names = TabList.getNames?.() || [];
            names.forEach((entry) => {
                const text = this.cleanText(typeof entry?.getName === 'function' ? entry.getName() : entry);
                if (text) texts.push(text);
            });
        } catch (e) {}

        try {
            const header = this.cleanText(TabList.getHeader?.() || '');
            if (header) texts.push(...header.split('\n').map((line) => this.cleanText(line)).filter(Boolean));
        } catch (e) {}

        try {
            const footer = this.cleanText(TabList.getFooter?.() || '');
            if (footer) texts.push(...footer.split('\n').map((line) => this.cleanText(line)).filter(Boolean));
        } catch (e) {}

        return texts;
    }

    hasDungeonEntityHints() {
        try {
            const stands = this.getArmorStands();
            if (stands.some((stand) => {
                const name = ChatLib.removeFormatting(String(stand?.getName?.() || '')).toLowerCase();
                return (
                    name.includes('blaze') ||
                    name.includes('silverfish') ||
                    name.includes('creeper') ||
                    name.includes('oruo') ||
                    name.includes('baxter') ||
                    name.includes('melrose') ||
                    name.includes('madelia') ||
                    name.includes('secrets found')
                );
            })) return true;
        } catch (e) {}

        return false;
    }

    cleanText(value) {
        let text = '';

        try {
            if (value && typeof value.getUnformattedText === 'function') text = value.getUnformattedText();
            else if (value && value.unformattedText != null) text = value.unformattedText;
            else if (value && typeof value.getString === 'function') text = value.getString();
            else if (value && value.string != null) text = value.string;
            else if (value && value.formattedText != null) text = value.formattedText;
            else text = String(value || '');
        } catch (e) {
            text = String(value || '');
        }

        return ChatLib.removeFormatting(String(text))
            .replace(/\u00a7[0-9a-fk-or]/gi, '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    hasRenderableTargets() {
        return !!(
            this.starredMobs.length ||
            this.weirdoChest ||
            this.quizTargets.length ||
            this.blazeTarget ||
            this.ticTacToeTarget ||
            this.waterTargets.length ||
            this.teleportPads.length ||
            this.boulderTarget ||
            this.iceFillPath.length ||
            this.icePathTarget ||
            this.creeperBeamTargets.length
        );
    }

    markDungeonSeen(duration = DUNGEON_CACHE_MS) {
        this.dungeonSeenUntil = Math.max(this.dungeonSeenUntil, Date.now() + duration);
    }

    handleCompletion() {
        const now = Date.now();
        if (now - this.lastCompletionMessage < 5000) return;

        this.lastCompletionMessage = now;
        this.completedAt = now;
        this.inCatacombsRun = false;
        this.dungeonActive = false;
        this.dungeonSeenUntil = 0;
        this.lastMapPacket = 0;
        this.mapSignals = 0;
        this.clearRuntimeTargets();
        this.message('&aDungeon complete.');

        if (this.autoGG) ScheduleTask(this.autoGGDelayTicks, () => ChatLib.say('gg'));
    }

    solverEnabled(name) {
        return this.enabledSolvers.has(name);
    }

    normalizeEnabledSolvers(options) {
        const selected = new Set((options || []).filter((option) => option.enabled).map((option) => option.name));
        const onlyOldDefaultNames = selected.size > 0 && [...selected].every((name) => OLD_DEFAULT_SOLVERS.includes(name));
        if (!selected.size || onlyOldDefaultNames) return new Set(DEFAULT_SOLVERS);
        return selected;
    }

    updateCurrentRoomBounds(force = false) {
        const now = Date.now();
        if (!force && this.roomBounds && now - this.roomBoundsAt < ROOM_CACHE_MS) return this.roomBounds;

        const playerPos = this.getPlayerPos();
        const floodBounds = this.computeWalkableRoomBounds(playerPos);
        if (floodBounds && floodBounds.width >= 10 && floodBounds.length >= 10) {
            this.roomBounds = floodBounds;
            this.roomBoundsSource = 'world';
        } else {
            this.roomBounds = this.getGridRoomBounds(playerPos);
            this.roomBoundsSource = 'grid';
        }

        this.roomBoundsAt = now;
        return this.roomBounds;
    }

    computeWalkableRoomBounds(playerPos) {
        const step = 4;
        const maxSteps = 10;
        const y = Math.floor(playerPos.y);
        const start = {
            x: Math.round(playerPos.x / step) * step,
            z: Math.round(playerPos.z / step) * step,
        };
        const queue = [start];
        const seen = new Set();
        const points = [];

        while (queue.length && points.length < 260) {
            const point = queue.shift();
            const key = `${point.x}:${point.z}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const dx = Math.abs(point.x - start.x) / step;
            const dz = Math.abs(point.z - start.z) / step;
            if (dx > maxSteps || dz > maxSteps) continue;
            if (!this.isColumnPassable(point.x, y, point.z)) continue;

            points.push(point);
            queue.push({ x: point.x + step, z: point.z });
            queue.push({ x: point.x - step, z: point.z });
            queue.push({ x: point.x, z: point.z + step });
            queue.push({ x: point.x, z: point.z - step });
        }

        if (points.length < 8) return null;

        const xs = points.map((point) => point.x);
        const zs = points.map((point) => point.z);
        const minX = Math.min(...xs) - step;
        const maxX = Math.max(...xs) + step;
        const minZ = Math.min(...zs) - step;
        const maxZ = Math.max(...zs) + step;

        return {
            minX,
            maxX,
            minZ,
            maxZ,
            minY: y - 8,
            maxY: y + 18,
            width: maxX - minX,
            length: maxZ - minZ,
            source: 'world',
        };
    }

    isColumnPassable(x, y, z) {
        for (let dy = 0; dy <= 2; dy++) {
            const id = this.getBlockIdAt(x, y + dy, z);
            if (!this.isPassableId(id)) return false;
        }
        return true;
    }

    isPassableId(id) {
        return (
            !id ||
            id.includes('air') ||
            id.includes('water') ||
            id.includes('torch') ||
            id.includes('lever') ||
            id.includes('button') ||
            id.includes('sign') ||
            id.includes('skull') ||
            id.includes('head') ||
            id.includes('banner') ||
            id.includes('carpet') ||
            id.includes('pressure_plate') ||
            id.includes('flower') ||
            id.includes('mushroom') ||
            id.includes('fire') ||
            id.includes('web') ||
            id.includes('tripwire')
        );
    }

    isAirId(id) {
        return !id || id.includes('air');
    }

    getGridRoomBounds(pos) {
        const corner = this.getDungeonRoomCorner(pos);
        return {
            minX: corner.x - 2,
            maxX: corner.x + DUNGEON_ROOM_SIZE + 1,
            minZ: corner.z - 2,
            maxZ: corner.z + DUNGEON_ROOM_SIZE + 1,
            minY: Math.floor(pos.y) - 10,
            maxY: Math.floor(pos.y) + 22,
            width: DUNGEON_ROOM_SIZE,
            length: DUNGEON_ROOM_SIZE,
            source: 'grid',
        };
    }

    getDungeonRoomKey(pos) {
        const corner = this.getDungeonRoomCorner(pos);
        return `${corner.x}:${corner.z}`;
    }

    getDungeonRoomCorner(pos) {
        const roomIndexX = Math.floor((Math.floor(pos.x) - DUNGEON_GRID_START) / GRID_ROOM_SIZE);
        const roomIndexZ = Math.floor((Math.floor(pos.z) - DUNGEON_GRID_START) / GRID_ROOM_SIZE);
        return {
            x: DUNGEON_GRID_START + roomIndexX * GRID_ROOM_SIZE,
            z: DUNGEON_GRID_START + roomIndexZ * GRID_ROOM_SIZE,
        };
    }

    getRoomTransformCandidates() {
        const pos = this.getPlayerPos();
        const corner = this.getDungeonRoomCorner(pos);
        const maxX = corner.x + DUNGEON_ROOM_SIZE - 1;
        const maxZ = corner.z + DUNGEON_ROOM_SIZE - 1;
        const detected = this.getDetectedRoomTransform(pos, corner, maxX, maxZ);
        if (detected) return [detected];

        const corners = [
            { x: corner.x, z: corner.z, rotation: 0 },
            { x: maxX, z: corner.z, rotation: 90 },
            { x: maxX, z: maxZ, rotation: 180 },
            { x: corner.x, z: maxZ, rotation: 270 },
        ];

        const bounds = this.roomBounds || this.getGridRoomBounds(pos);
        if (bounds) {
            corners.push(
                { x: bounds.minX + 2, z: bounds.minZ + 2, rotation: 0 },
                { x: bounds.maxX - 2, z: bounds.minZ + 2, rotation: 90 },
                { x: bounds.maxX - 2, z: bounds.maxZ - 2, rotation: 180 },
                { x: bounds.minX + 2, z: bounds.maxZ - 2, rotation: 270 }
            );
        }

        const seen = new Set();
        return corners.filter((corner) => {
            const key = `${corner.x}:${corner.z}:${corner.rotation}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    getDetectedRoomTransform(pos, corner, maxX, maxZ) {
        pos = pos || this.getPlayerPos();
        corner = corner || this.getDungeonRoomCorner(pos);
        if (maxX == null) maxX = corner.x + DUNGEON_ROOM_SIZE - 1;
        if (maxZ == null) maxZ = corner.z + DUNGEON_ROOM_SIZE - 1;

        const roomKey = this.getDungeonRoomKey(pos);
        const now = Date.now();
        if (this.roomTransformKey === roomKey && now - this.roomTransformAt < ROOM_TRANSFORM_CACHE_MS) return this.roomTransform;

        const centerX = corner.x + DUNGEON_ROOM_HALF;
        const centerZ = corner.z + DUNGEON_ROOM_HALF;
        const height = this.getHighestRoomY(centerX, centerZ);
        let transform = null;

        if (height != null) {
            const candidates = [
                { x: corner.x, z: corner.z, rotation: 0 },
                { x: maxX, z: corner.z, rotation: 90 },
                { x: maxX, z: maxZ, rotation: 180 },
                { x: corner.x, z: maxZ, rotation: 270 },
            ];

            transform = candidates.find((candidate) => this.getBlockIdAt(candidate.x, height, candidate.z).includes('blue_terracotta')) || null;
        }

        this.roomTransform = transform;
        this.roomTransformKey = roomKey;
        this.roomTransformAt = now;
        return transform;
    }

    getHighestRoomY(x, z) {
        for (let y = 140; y >= 12; y--) {
            const id = this.getBlockIdAt(x, y, z);
            if (!id || id.includes('air') || id.includes('gold_block')) continue;
            return y;
        }
        return null;
    }

    fromComp(transform, x, y, z) {
        const rotated = this.rotateComp(x, z, transform.rotation);
        return { x: Math.round(transform.x + rotated.x), y, z: Math.round(transform.z + rotated.z) };
    }

    toComp(transform, x, y, z) {
        const dx = x - transform.x;
        const dz = z - transform.z;
        if (transform.rotation === 90) return { x: dz, y, z: -dx };
        if (transform.rotation === 180) return { x: -dx, y, z: -dz };
        if (transform.rotation === 270) return { x: -dz, y, z: dx };
        return { x: dx, y, z: dz };
    }

    rotateComp(x, z, rotation) {
        if (rotation === 90) return { x: -z, z: x };
        if (rotation === 180) return { x: -x, z: -z };
        if (rotation === 270) return { x: z, z: -x };
        return { x, z };
    }

    bestTransformByProbes(probes, minScore = null) {
        if (!Array.isArray(probes) || !probes.length) return null;
        const requiredScore = minScore == null ? probes.length : minScore;
        let best = null;
        let bestScore = 0;
        this.getRoomTransformCandidates().forEach((transform) => {
            const score = this.scoreTransformProbes(transform, probes);
            if (score > bestScore) {
                bestScore = score;
                best = transform;
            }
        });
        return bestScore >= requiredScore ? best : null;
    }

    scoreTransformProbes(transform, probes) {
        return probes.reduce((score, probe) => score + (this.probeMatches(transform, probe) ? 1 : 0), 0);
    }

    probeMatches(transform, probe) {
        const pos = this.fromComp(transform, probe.x, probe.y, probe.z);
        const id = this.getBlockIdAt(pos.x, pos.y, pos.z);
        if (probe.any) return probe.any.some((part) => id.includes(part));
        return id.includes(probe.id);
    }

    isInsideCurrentRoom(pos) {
        if (!pos) return false;
        const bounds = this.roomBounds || this.updateCurrentRoomBounds(false) || this.getGridRoomBounds(this.getPlayerPos());
        return this.isInsideBounds(pos, bounds) || this.isInsideGridRoom(pos);
    }

    isInsideGridRoom(pos) {
        if (!pos) return false;
        const bounds = this.getGridRoomBounds(this.getPlayerPos());
        return this.isInsideBounds(pos, bounds);
    }

    isInsideBounds(pos, bounds) {
        return pos.x >= bounds.minX && pos.x <= bounds.maxX && pos.z >= bounds.minZ && pos.z <= bounds.maxZ && pos.y >= bounds.minY && pos.y <= bounds.maxY;
    }

    isRelevantRoomPos(pos) {
        if (!pos) return false;
        if (this.isInsideCurrentRoom(pos)) return true;

        const playerPos = this.getPlayerPos();
        return (
            this.horizontalDistanceSq(pos, playerPos) <= ROOM_FALLBACK_HORIZONTAL_RADIUS * ROOM_FALLBACK_HORIZONTAL_RADIUS &&
            Math.abs(pos.y - playerPos.y) <= ROOM_FALLBACK_VERTICAL_RADIUS
        );
    }

    updateStarredMobs() {
        if (!World.isLoaded()) {
            this.starredMobs = [];
            return;
        }

        const playerPos = this.getPlayerPos();
        const maxDistanceSq = this.starredMobRange * this.starredMobRange;
        const allEntities = World.getAllEntities() || [];
        const stands = this.getArmorStands();
        const seen = new Set();
        const targets = [];

        stands.forEach((stand) => {
            if (!stand || stand.isDead?.()) return;

            const label = ChatLib.removeFormatting(String(stand.getName?.() || ''));
            if (!this.isStarredName(label)) return;

            const standPos = this.getEntityPos(stand);
            if (!standPos || this.distanceSq(standPos, playerPos) > maxDistanceSq) return;
            if (this.starredMobRoomOnly && !this.isRelevantRoomPos(standPos)) return;

            const entity = this.findMobBelowNametag(stand, allEntities) || stand;
            const fallbackBox = entity === stand;
            const entityPos = fallbackBox ? { x: standPos.x, y: standPos.y - 2.1, z: standPos.z } : this.getEntityPos(entity) || standPos;
            if (this.starredMobRoomOnly && !this.isRelevantRoomPos(entityPos)) return;

            const id = this.getEntityKey(entity) || `${Math.round(entityPos.x * 10)}:${Math.round(entityPos.y * 10)}:${Math.round(entityPos.z * 10)}`;
            if (seen.has(id)) return;

            seen.add(id);
            targets.push({
                entity,
                label: this.cleanMobLabel(label),
                pos: entityPos,
                fallbackBox,
            });
        });

        allEntities.forEach((entity) => {
            if (!entity || entity.isDead?.() || this.isArmorStandEntity(entity) || this.isLikelyPlayer(entity)) return;
            const label = ChatLib.removeFormatting(String(entity.getName?.() || ''));
            if (!this.isStarredName(label)) return;
            const pos = this.getEntityPos(entity);
            if (!pos || this.distanceSq(pos, playerPos) > maxDistanceSq) return;
            if (this.starredMobRoomOnly && !this.isRelevantRoomPos(pos)) return;
            const id = this.getEntityKey(entity) || `${Math.round(pos.x * 10)}:${Math.round(pos.y * 10)}:${Math.round(pos.z * 10)}`;
            if (seen.has(id)) return;

            seen.add(id);
            targets.push({
                entity,
                label: this.cleanMobLabel(label),
                pos,
                fallbackBox: false,
            });
        });

        this.starredMobs = targets;
    }

    renderStarredMobs() {
        const targets = Array.isArray(this.starredMobs) ? this.starredMobs : [];
        targets.forEach((target) => {
            if (!target) return;
            const entity = target.entity;
            if (!entity || entity.isDead?.()) return;

            const pos = this.getEntityPos(entity) || target.pos;
            if (this.starredMobRoomOnly && !this.isRelevantRoomPos(pos)) return;

            const width = target.fallbackBox ? 0.9 : typeof entity.getWidth === 'function' ? entity.getWidth() : 0.8;
            const height = target.fallbackBox ? 2.1 : typeof entity.getHeight === 'function' ? entity.getHeight() : 2.0;
            if (pos && Number.isFinite(width) && Number.isFinite(height)) {
                Render.drawSizedBox(new Vec3d(pos.x, pos.y, pos.z), width, height, width, this.starredMobColor, false, this.starredMobThickness, false);
                if (this.starredMobLabels) this.drawText(target.label || 'Starred Mob', { x: pos.x, y: pos.y + height + 0.45, z: pos.z }, 1.0);
            }
        });
    }

    isStarredName(name) {
        const clean = ChatLib.removeFormatting(String(name || ''));
        if (!clean || clean === 'Armor Stand') return false;
        for (let i = 0; i < clean.length; i++) {
            if (STAR_MARKERS.includes(clean.charCodeAt(i))) return true;
        }
        const lower = clean.toLowerCase();
        return lower.includes('starred') || lower.includes('[star]');
    }

    handleThreeWeirdosChat(clean) {
        const match = clean.match(WEIRDO_TRUTH_LINE);
        if (!match) return;

        const name = match[1];
        this.setDungeonActive('three weirdos');
        const chest = this.findChestForWeirdo(name);
        this.weirdoChest = chest;
        this.weirdoSolvedAt = Date.now();
        this.setSolverHint('Three Weirdos', `Open ${name}'s chest`);
        this.message(`&aThree Weirdos: open ${name}'s chest.`);

        if (chest) this.safeAutoClick('Three Weirdos', chest, 2);
        else this.message('&eCorrect weirdo found, but the Skyblocker chest position could not be mapped.');
    }

    renderThreeWeirdos() {
        if (!this.weirdoChest) return;
        this.drawBlockTarget(this.weirdoChest, 'Open', Render.Color(80, 255, 120, 70), Render.Color(80, 255, 120, 255));
    }

    solveThreeWeirdos() {
        const people = Array.from(this.weirdoStatements.keys());
        if (people.length !== 3) return null;

        const known = this.solveKnownWeirdoPattern(people);
        if (known) return { name: known };

        const possible = new Set();
        for (const candidate of people) {
            for (let mask = 0; mask < 8; mask++) {
                const truthMap = {};
                people.forEach((person, index) => (truthMap[person] = ((mask >> index) & 1) === 1));

                let valid = true;
                for (const person of people) {
                    const value = this.evaluateWeirdoStatement(this.weirdoStatements.get(person), person, candidate, truthMap, people);
                    if (value == null || value !== truthMap[person]) {
                        valid = false;
                        break;
                    }
                }
                if (valid) possible.add(candidate);
            }
        }

        return possible.size === 1 ? { name: Array.from(possible)[0] } : null;
    }

    solveKnownWeirdoPattern(people) {
        const data = people.map((person) => ({ person, statement: this.normalize(this.weirdoStatements.get(person)) }));
        const find = (...phrases) => {
            const normalized = phrases.map((phrase) => this.normalize(phrase));
            return data.find((entry) => normalized.every((phrase) => entry.statement.includes(phrase)))?.person || null;
        };

        const rewardNotMine = data.find((entry) => {
            const text = entry.statement;
            return (text.includes('reward is not in my chest') || text.includes('reward isn t in my chest')) && !text.includes('any of our chests');
        })?.person;
        if (rewardNotMine && find('one of us is telling the truth') && find('they are both telling the truth')) return rewardNotMine;
        if (find('reward isn t in any of our chests') && find('they are both lying') && find('reward is in my chest')) return find('reward is in my chest');

        const allTruthSpeaker = data.find((entry) => entry.statement.includes('my chest doesn t have the reward') && entry.statement.includes('we are all telling the truth'))?.person;
        if (allTruthSpeaker && find('at least one of the others is telling the truth') && find('one of the others is lying')) return allTruthSpeaker;

        const selfTruthSpeaker = data.find((entry) => entry.statement.includes('my chest has the reward') && entry.statement.includes('i m telling the truth'))?.person;
        if (selfTruthSpeaker && find('they are both lying') && find('they are both telling the truth')) return selfTruthSpeaker;

        const lastMyChest = data.find((entry) => entry.statement === 'my chest has the reward')?.person;
        if (lastMyChest && find('both of them are telling the truth') && find('has the reward in their chest')) return lastMyChest;

        return null;
    }

    evaluateWeirdoStatement(statement, speaker, candidate, truthMap, people) {
        const clauses = this.normalize(statement)
            .split(/\s+(?:and|but)\s+/)
            .map((clause) => clause.trim())
            .filter(Boolean);
        if (!clauses.length) return null;

        const values = clauses.map((clause) => this.evaluateWeirdoClause(clause, speaker, candidate, truthMap, people));
        if (values.some((value) => value == null)) return null;
        return values.every((value) => value === true);
    }

    evaluateWeirdoClause(clause, speaker, candidate, truthMap, people) {
        const truthCount = people.filter((person) => truthMap[person]).length;
        const names = people.filter((person) => clause.includes(this.normalize(person)));

        if (clause.includes('all of us') && this.hasTruthPhrase(clause)) return truthCount === people.length;
        if ((clause.includes('only one') || clause.includes('exactly one')) && this.hasTruthPhrase(clause)) return truthCount === 1;
        if (clause.includes('at least one') && this.hasTruthPhrase(clause)) return truthCount >= 1;
        if (clause.includes('at least one') && this.hasLiePhrase(clause)) return truthCount < people.length;
        if (clause.includes('one of us') && this.hasLiePhrase(clause)) return truthCount === people.length - 1;
        if (clause.includes('all of us') && this.hasLiePhrase(clause)) return truthCount === 0;

        if (clause.includes('i am') && this.hasTruthPhrase(clause)) return this.isNegated(clause) ? !truthMap[speaker] : !!truthMap[speaker];
        if (clause.includes('i am') && this.hasLiePhrase(clause)) return this.isNegated(clause) ? !!truthMap[speaker] : !truthMap[speaker];

        if (names.length && this.hasTruthPhrase(clause)) return this.isNegated(clause) ? names.every((name) => !truthMap[name]) : names.every((name) => !!truthMap[name]);
        if (names.length && this.hasLiePhrase(clause)) return this.isNegated(clause) ? names.every((name) => !!truthMap[name]) : names.every((name) => !truthMap[name]);

        if (clause.includes('reward') && clause.includes('chest')) {
            if (clause.includes('neither') && names.length) return !names.includes(candidate);
            const target = clause.includes('my chest') ? speaker : names[0];
            if (!target) return null;
            return this.isNegated(clause) ? candidate !== target : candidate === target;
        }

        return null;
    }

    looksLikeWeirdoStatement(text) {
        const lower = String(text || '').toLowerCase();
        return ['reward', 'chest', 'truth', 'lying', 'liar', ' lie', 'correct', 'wrong'].some((phrase) => lower.includes(phrase));
    }

    isKnownCorrectWeirdoStatement(statement) {
        const text = this.normalize(statement);
        return (
            (text.includes('reward is not in my chest') && !text.includes('any of our chests')) ||
            (text.includes('at least one of them is lying') && text.includes('reward is not in') && text.includes('chest')) ||
            (text.includes('my chest doesn t have the reward') && text.includes('we are all telling the truth')) ||
            (text.includes('my chest has the reward') && text.includes('i m telling the truth')) ||
            text.includes('reward isn t in any of our chests') ||
            text.includes('reward isnt in any of our chests') ||
            (text.includes('both of them are telling the truth') && text.includes('has the reward in their chest'))
        );
    }

    hasTruthPhrase(text) {
        return text.includes('truth') || text.includes('right') || text.includes('correct');
    }

    hasLiePhrase(text) {
        return text.includes('lying') || text.includes('lie') || text.includes('liar') || text.includes('wrong');
    }

    isNegated(text) {
        return /\b(?:not|isnt|isn t|doesnt|doesn t|never|no)\b/.test(text);
    }

    isWeirdoNpcLine(lower) {
        return WEIRDO_TRUTH_LINE.test(this.cleanText(lower));
    }

    findChestForWeirdo(name) {
        const normalized = this.normalize(name);
        const stands = this.getArmorStands();
        const candidates = [];

        this.getRoomTransformCandidates().forEach((transform) => {
            WEIRDO_NPC_RELS.forEach((rel) => {
                const expected = this.fromComp(transform, rel.x, rel.y, rel.z);
                const stand = stands.find((entity) => {
                    const label = this.normalize(entity?.getName?.() || '');
                    if (label !== normalized && !label.includes(normalized)) return false;
                    const pos = this.getEntityPos(entity);
                    return pos && this.distanceSq(pos, expected) <= 4.5;
                });
                if (!stand) return;

                const chest = this.fromComp(transform, rel.x + 1, rel.y, rel.z);
                if (!this.getBlockIdAt(chest.x, chest.y, chest.z).includes('chest')) return;
                candidates.push({ chest, score: this.distanceSq(chest, this.getPlayerPos()) });
            });
        });

        candidates.sort((a, b) => a.score - b.score);
        return candidates[0]?.chest || null;
    }

    handleQuizChat(clean, lower) {
        if (lower.includes('answered question') || lower.includes('answered the final question') || lower.includes('[statue] oruo') && lower.includes('yikes')) {
            this.resetQuizSolution();
            return;
        }

        const option = this.parseQuizOption(clean);
        if (option) {
            if (!this.quizAnswers.length) return;

            this.quizOptionAnswers.set(option.letter, option.text);
            const normalizedOption = this.normalizeQuizAnswer(option.text);
            const answers = this.quizAnswers.map((answer) => this.normalizeQuizAnswer(answer));
            if (answers.some((answer) => normalizedOption === answer || normalizedOption.includes(answer) || answer.includes(normalizedOption))) {
                this.setDungeonActive('quiz');
                this.quizCurrentAnswerLetter = option.letter;
                this.setSolverHint('Quiz', `Answer ${option.letter}: ${option.text}`);
            }
            return;
        }

        if (!lower.includes('oruo') && !lower.includes('?')) return;

        const normalized = this.normalize(clean);
        let answers = null;
        if (normalized.includes('what skyblock year is it')) {
            answers = [this.currentSkyblockYear()];
        } else {
            const match = QUIZ_ANSWERS.find((entry) => normalized.includes(this.normalize(entry.q)));
            if (!match) return;
            answers = match.a;
        }

        this.setDungeonActive('quiz');
        this.quizAnswers = answers;
        this.quizCurrentAnswerLetter = null;
        this.quizOptionAnswers.clear();
        this.setSolverHint('Quiz', `Answer: ${answers.join(' / ')}`);
        this.message(`&aQuiz answer: &f${answers.join(' &7/ &f')}`);
    }

    updateQuizTargets() {
        if (!this.quizAnswers.length) {
            this.quizTargets = [];
            return;
        }

        if (this.quizCurrentAnswerLetter) {
            const button = this.findQuizButtonByLetter(this.quizCurrentAnswerLetter);
            if (button) {
                const answer = this.quizOptionAnswers.get(this.quizCurrentAnswerLetter) || this.quizAnswers[0] || this.quizCurrentAnswerLetter;
                this.quizTargets = [{ answer, button, pos: this.centerOf(button), confident: true }];
                this.safeAutoClick('Quiz', button, 1);
                return;
            }
        }

        const playerPos = this.getPlayerPos();
        const answers = this.quizAnswers.map((answer) => this.normalizeQuizAnswer(answer));
        const targets = [];
        const seen = new Set();

        this.getArmorStands().forEach((stand) => {
            const label = ChatLib.removeFormatting(String(stand?.getName?.() || '')).trim();
            const normalized = this.normalizeQuizAnswer(label);
            if (!answers.some((answer) => normalized.includes(answer))) return;

            const pos = this.getEntityPos(stand);
            if (!pos || this.distanceSq(pos, playerPos) > 60 * 60 || !this.isRelevantRoomPos(pos)) return;

            const button = this.findNearestButton(pos, 5);
            const key = button ? this.blockKey(button) : `${Math.round(pos.x)}:${Math.round(pos.y)}:${Math.round(pos.z)}`;
            if (seen.has(key)) return;

            seen.add(key);
            targets.push({ answer: label, button, pos });
        });

        this.quizTargets = targets;
        if (targets.length === 1 && targets[0].button && targets[0].confident) this.safeAutoClick('Quiz', targets[0].button, 1);
    }

    parseQuizOption(clean) {
        const text = this.cleanText(clean);
        if (!text) return null;

        const code = text.codePointAt(0);
        const circled = {
            0x24d0: 'A',
            0x24d1: 'B',
            0x24d2: 'C',
        };

        if (circled[code]) {
            return { letter: circled[code], text: text.slice(1).trim() };
        }

        const match = text.match(/^\(?([ABCabc])\)?[\s:.)-]+(.+)$/);
        if (!match) return null;
        return { letter: match[1].toUpperCase(), text: match[2].trim() };
    }

    normalizeQuizAnswer(text) {
        return this.normalize(text);
    }

    currentSkyblockYear() {
        return `Year ${Math.floor((Date.now() / 1000 - 1560276000) / 446400) + 1}`;
    }

    resetQuizSolution() {
        this.quizAnswers = [];
        this.quizTargets = [];
        this.quizCurrentAnswerLetter = null;
        this.quizOptionAnswers.clear();
    }

    findQuizButtonByLetter(letter) {
        const comp = QUIZ_ANSWER_BUTTONS[letter];
        if (!comp) return null;

        const candidates = [];
        this.getRoomTransformCandidates().forEach((transform) => {
            const expected = this.fromComp(transform, comp.x, comp.y, comp.z);
            let button = null;
            if (this.idMatches(this.getBlockIdAt(expected.x, expected.y, expected.z), BUTTON_IDS)) button = expected;
            else button = this.findNearestButton(expected, 3);

            if (!button || !this.isRelevantRoomPos(button)) return;
            candidates.push({
                button,
                score: this.distanceSq(button, expected) + this.distanceSq(button, this.getPlayerPos()) * 0.01,
            });
        });

        candidates.sort((a, b) => a.score - b.score);
        return candidates[0]?.button || null;
    }

    renderQuiz() {
        const targets = Array.isArray(this.quizTargets) ? this.quizTargets : [];
        targets.forEach((target) => {
            if (!target) return;
            if (target.button) this.drawBlockTarget(target.button, 'Answer', Render.Color(60, 255, 120, 70), Render.Color(60, 255, 120, 255));
            if (target.pos) this.drawText(target.answer, { x: target.pos.x, y: target.pos.y + 0.6, z: target.pos.z }, 0.95);
        });
    }

    updateBlazeSolver() {
        const blazes = this.getPuzzleBlazes();
        if (blazes.length < 5) {
            this.blazeTarget = null;
            this.blazeTargetHealth = null;
            this.blazeNextTarget = null;
            this.blazeNextHealth = null;
            return;
        }

        const sorted = blazes.slice().sort((a, b) => a.health - b.health);
        const lowest = sorted[0];
        const highest = sorted[sorted.length - 1];
        const lowestY = this.getEntityPos(lowest.stand || lowest.entity)?.y;
        const highestY = this.getEntityPos(highest.stand || highest.entity)?.y;
        let target = null;
        let next = null;
        let order = null;

        if (Number.isFinite(highestY) && highestY < 69) {
            target = highest;
            next = sorted[sorted.length - 2] || null;
            order = 'High -> Low';
        } else if (Number.isFinite(lowestY) && lowestY > 69) {
            target = lowest;
            next = sorted[1] || null;
            order = 'Low -> High';
        }

        if (!target) {
            this.blazeTarget = null;
            this.blazeTargetHealth = null;
            this.blazeNextTarget = null;
            this.blazeNextHealth = null;
            this.setSolverHint('Higher or Lower', 'Waiting for Skyblocker blaze room height check');
            return;
        }

        this.blazeTarget = target.entity;
        this.blazeTargetHealth = target.health;
        this.blazeNextTarget = next?.entity || null;
        this.blazeNextHealth = next?.health || null;
        this.setSolverHint('Higher or Lower', `${order}: kill ${target.health} HP`);
    }

    renderBlaze() {
        if (!this.blazeTarget || this.blazeTarget.isDead?.()) return;
        this.drawEntityHitbox(this.blazeTarget, Render.Color(80, 255, 120, 255), 5);
        const pos = this.getEntityPos(this.blazeTarget);
        if (pos) this.drawText(`Kill ${this.blazeTargetHealth}`, { x: pos.x, y: pos.y + 2.2, z: pos.z }, 1.05);
        if (this.blazeNextTarget && !this.blazeNextTarget.isDead?.()) {
            this.drawEntityHitbox(this.blazeNextTarget, Render.Color(255, 255, 255, 190), 3);
            const nextPos = this.getEntityPos(this.blazeNextTarget);
            if (pos && nextPos) this.drawLine({ x: pos.x, y: pos.y + 1.2, z: pos.z }, { x: nextPos.x, y: nextPos.y + 1.2, z: nextPos.z }, Render.Color(255, 255, 255, 170), 2);
        }
    }

    getPuzzleBlazes() {
        const allEntities = World.getAllEntities() || [];
        return this.getArmorStands()
            .map((stand) => {
                const name = ChatLib.removeFormatting(String(stand?.getName?.() || ''));
                if (!name.toLowerCase().includes('blaze')) return null;
                const health = this.parseBlazeHealth(name);
                if (health <= 0 || health > 100000000) return null;
                const pos = this.getEntityPos(stand);
                if (pos && !this.isRelevantRoomPos(pos)) return null;
                return {
                    entity: this.findMobBelowNametag(stand, allEntities) || stand,
                    stand,
                    health,
                };
            })
            .filter(Boolean);
    }

    updateTicTacToeSolver() {
        const board = this.findTicTacToeBoard();
        if (!board) {
            this.ticTacToeTarget = null;
            return;
        }

        const move = this.chooseTicTacToeMove(board.cells);
        this.ticTacToeTarget = move ? Object.assign({}, move, { board }) : null;
        if (move) {
            this.setSolverHint('Tic Tac Toe', `Highlight ${move.reason}`);
            this.safeAutoClick('Tic Tac Toe', move.button, 1);
        }
    }

    findTicTacToeBoard() {
        return this.findComponentTicTacToeBoard();
    }

    findComponentTicTacToeBoard() {
        let best = null;

        this.getRoomTransformCandidates().forEach((transform) => {
            const cells = TTT_BUTTON_COMPS.map(([x, y, z], index) => {
                const expected = this.fromComp(transform, x, y, z);
                let button = null;
                if (this.idMatches(this.getBlockIdAt(expected.x, expected.y, expected.z), BUTTON_IDS)) button = expected;
                else button = this.findNearestButton(expected, 2);
                return button && this.isRelevantRoomPos(button) ? { index, button, expected } : null;
            });

            if (cells.some((cell) => !cell)) return;
            const score = cells.reduce((sum, cell) => sum + this.distanceSq(cell.button, cell.expected), 0);
            if (!best || score < best.score) best = { score, cells, transform };
        });

        if (!best) return null;
        const frameStates = TTT_FRAME_COMPS.map(([x, y, z]) => this.detectTicTacToeFrameState(this.fromComp(best.transform, x, y, z)));
        return this.buildTicTacToeBoard(
            best.cells.map((cell) => ({
                index: cell.index,
                button: cell.button,
                state: frameStates[cell.index] || this.detectTicTacToeCellState(cell.button),
            }))
        );
    }

    buildTicTacToeBoard(cells) {
        return { cells };
    }

    detectTicTacToeCellState(button) {
        const nearby = this.findNearbyBlocks(button, 2, (block, pos) => this.distanceSq(pos, button) <= 6);
        const joined = nearby.map((pos) => this.getBlockIdAt(pos.x, pos.y, pos.z)).join(' ');
        if (joined.includes('lime') || joined.includes('green') || joined.includes('emerald')) return 'O';
        if (joined.includes('red') || joined.includes('black') || joined.includes('coal')) return 'X';
        return 'empty';
    }

    detectTicTacToeFrameState(framePos) {
        const frame = (World.getAllEntities() || []).find((entity) => {
            const pos = this.getEntityPos(entity);
            if (!pos || Math.floor(pos.x) !== framePos.x || Math.floor(pos.y) !== framePos.y || Math.floor(pos.z) !== framePos.z) return false;
            try {
                return String((entity?.toMC?.() || entity)?.getClass?.()?.getName?.() || '').includes('ItemFrame');
            } catch (e) {
                return false;
            }
        });
        if (!frame) return null;

        const colors = this.getItemFrameMapColors(frame);
        if (!colors) return null;

        const markerIndex = this.indexOfMapColor(colors, 114);
        if (markerIndex < 0) return null;
        return markerIndex === 2700 ? 'X' : 'O';
    }

    getItemFrameMapColors(frame) {
        try {
            const mcFrame = frame?.toMC?.() || frame;
            const stack = mcFrame.getHeldItemStack?.() || mcFrame.getHeldItem?.() || mcFrame.getItemStack?.();
            if (!stack) return null;

            const world = Client.getMinecraft?.()?.world || World.getWorld?.();
            if (!world) return null;

            let FilledMapItem = null;
            try {
                FilledMapItem = net.minecraft.item.FilledMapItem;
            } catch (e) {}
            let MapItem = null;
            try {
                MapItem = net.minecraft.world.item.MapItem;
            } catch (e) {}

            let mapId = null;
            try {
                mapId = mcFrame.getFramedMapId?.(stack);
            } catch (e) {}
            try {
                if (mapId == null && FilledMapItem?.getMapId) mapId = FilledMapItem.getMapId(stack);
            } catch (e) {}

            let mapData = null;
            try {
                if (mapId != null && world.getMapState) mapData = world.getMapState(mapId);
            } catch (e) {}
            try {
                if (!mapData && mapId != null && MapItem?.getSavedData) mapData = MapItem.getSavedData(mapId, world);
            } catch (e) {}
            try {
                if (!mapData && mapId != null && FilledMapItem?.getMapState) mapData = FilledMapItem.getMapState(mapId, world);
            } catch (e) {}

            return mapData?.colors || null;
        } catch (e) {
            return null;
        }
    }

    indexOfMapColor(colors, color) {
        const length = Number(colors.length || 0);
        for (let i = 0; i < length; i++) {
            if ((Number(colors[i]) & 0xff) === color) return i;
        }
        return -1;
    }

    chooseTicTacToeMove(cells) {
        const board = cells.map((cell) => cell.state);
        const move = this.bestTicTacToeMove(board);
        if (move != null) return Object.assign({}, cells[move], { reason: this.describeTicTacToeMove(board, move) });
        return null;
    }

    describeTicTacToeMove(board, move) {
        for (const line of TTT_LINES) {
            const values = line.map((index) => (index === move ? 'O' : board[index]));
            if (values.every((value) => value === 'O')) return 'winning move';
        }
        for (const line of TTT_LINES) {
            const values = line.map((index) => board[index]);
            if (line.includes(move) && values.filter((value) => value === 'X').length === 2 && values.includes('empty')) return 'block';
        }
        if (move === 4) return 'center';
        if ([0, 2, 6, 8].includes(move)) return 'corner';
        return 'side';
    }

    bestTicTacToeMove(board) {
        let bestScore = -Infinity;
        let bestMove = null;

        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
                const index = row * 3 + col;
                if (board[index] !== 'empty') continue;
                const next = board.slice();
                next[index] = 'O';
                const score = this.scoreTicTacToe(next, -Infinity, Infinity, 0, false);
                if (score > bestScore) {
                    bestScore = score;
                    bestMove = index;
                }
            }
        }

        return bestMove;
    }

    scoreTicTacToe(board, alpha, beta, depth, maximizing) {
        const winner = this.ticTacToeWinner(board);
        if (winner === 'O') return 10;
        if (winner === 'X') return -10;
        if (!board.includes('empty')) return 0;

        if (maximizing) {
            let value = -Infinity;
            for (let index = 0; index < 9; index++) {
                if (board[index] !== 'empty') continue;
                board[index] = 'O';
                value = Math.max(value, this.scoreTicTacToe(board, alpha, beta, depth + 1, false) - depth);
                board[index] = 'empty';
                alpha = Math.max(alpha, value);
                if (alpha >= beta) break;
            }
            return value;
        }

        let value = Infinity;
        for (let index = 0; index < 9; index++) {
            if (board[index] !== 'empty') continue;
            board[index] = 'X';
            value = Math.min(value, this.scoreTicTacToe(board, alpha, beta, depth + 1, true) + depth);
            board[index] = 'empty';
            beta = Math.min(beta, value);
            if (alpha >= beta) break;
        }
        return value;
    }

    ticTacToeWinner(board) {
        for (const line of TTT_LINES) {
            const [a, b, c] = line;
            if (board[a] !== 'empty' && board[a] === board[b] && board[a] === board[c]) return board[a];
        }
        return null;
    }

    renderTicTacToe() {
        const target = this.ticTacToeTarget;
        if (!target || !target.button) return;
        this.drawBlockTarget(target.button, target.reason || 'Move', Render.Color(80, 190, 255, 70), Render.Color(80, 190, 255, 255));
    }

    getWaterBoardTargets() {
        return Array.isArray(this.waterTargets) ? this.waterTargets : [];
    }

    updateWaterBoardSolver() {
        const transform = this.bestTransformByProbes([
            { x: 20, y: 61, z: 20, any: LEVER_IDS },
            { x: 10, y: 61, z: 20, any: LEVER_IDS },
            { x: 15, y: 60, z: 5, any: LEVER_IDS },
        ], 2);
        if (!transform) {
            this.resetWaterBoardState();
            return;
        }

        const transformKey = `${transform.x}:${transform.z}:${transform.rotation}`;
        if (this.waterTransformKey !== transformKey) {
            this.resetWaterBoardState();
            this.waterTransformKey = transformKey;
            this.waterTransform = transform;
        }

        if (!Object.keys(WATER_SOLUTIONS).length) {
            this.waterTargets = [];
            this.setSolverHint('Water Board', 'Missing Skyblocker water timing data');
            return;
        }

        if (this.waterFinished && this.waterSolution) {
            this.updateWaterBoardTiming();
            return;
        }

        const variant = this.findWaterBoardVariant(transform);
        if (!variant) {
            this.waterTargets = [];
            this.setSolverHint('Water Board', 'Waiting for Skyblocker waterboard variant');
            return;
        }

        const doors = this.findWaterBoardDoors(transform);
        const variantSolutions = WATER_SOLUTIONS[String(variant)];
        const data = variantSolutions ? variantSolutions[doors] : null;
        if (!data) {
            this.waterTargets = [];
            this.setSolverHint('Water Board', `No Skyblocker timing for variant ${variant}, doors ${doors || 'none'}`);
            return;
        }

        if (!this.checkWaterBoardEmpty(transform)) {
            this.waterTargets = [];
            this.setSolverHint('Water Board', 'Water already running; waiting for reset');
            return;
        }

        this.waterVariant = variant;
        this.waterDoors = doors;
        this.waterInitialDoors = doors;
        this.waterSolution = this.setupWaterBoardSolution(transform, variant, data);
        this.waterFinished = true;
        this.updateWaterBoardTiming();
        this.setSolverHint('Water Board', `Skyblocker one-flow: variant ${variant}, doors ${doors || 'none'}`);
    }

    resetWaterBoardState() {
        this.waterTargets = [];
        this.waterTransformKey = null;
        this.waterTransform = null;
        this.waterVariant = 0;
        this.waterDoors = null;
        this.waterInitialDoors = null;
        this.waterSolution = null;
        this.waterStartMillis = 0;
        this.waterFinished = false;
    }

    findWaterBoardVariant(transform) {
        const detected = new Set();
        for (let x = WATER_ENTRANCE.x - 1; x <= WATER_ENTRANCE.x + 1; x++) {
            for (let y = WATER_ENTRANCE.y - 1; y <= WATER_ENTRANCE.y; y++) {
                for (let z = WATER_ENTRANCE.z; z <= WATER_ENTRANCE.z + 1; z++) {
                    const pos = this.fromComp(transform, x, y, z);
                    const id = this.getBlockIdAt(pos.x, pos.y, pos.z);
                    Object.entries(WATER_LEVER_TYPES).forEach(([key, lever]) => {
                        if (key !== 'water' && id.includes(lever.block)) detected.add(key);
                    });
                }
            }
        }

        if (detected.has('gold') && detected.has('terracotta')) return 1;
        if (detected.has('emerald') && detected.has('quartz')) return 2;
        if (detected.has('quartz') && detected.has('diamond')) return 3;
        if (detected.has('gold') && detected.has('quartz')) return 4;
        return 0;
    }

    findWaterBoardDoors(transform) {
        let doors = '';
        for (let i = 0; i < 5; i++) {
            const pos = this.fromComp(transform, 15, 57, 19 - i);
            if (!this.isAirId(this.getBlockIdAt(pos.x, pos.y, pos.z))) doors += String(i);
        }
        return doors;
    }

    checkWaterBoardEmpty(transform) {
        for (let x = WATER_BOARD_MIN_X; x <= WATER_BOARD_MAX_X; x++) {
            for (let y = WATER_BOARD_MIN_Y; y <= WATER_BOARD_MAX_Y; y++) {
                const pos = this.fromComp(transform, x, y, WATER_BOARD_Z);
                if (this.getBlockIdAt(pos.x, pos.y, pos.z).includes('water')) return false;
            }
        }
        return true;
    }

    setupWaterBoardSolution(transform, variant, data) {
        const solution = {};
        WATER_LEVER_ORDER.forEach((key) => (solution[key] = []));
        Object.entries(data || {}).forEach(([key, times]) => {
            const normalized = key.toLowerCase();
            if (!solution[normalized]) return;
            solution[normalized] = (Array.isArray(times) ? times : []).map((time) => Number(time)).filter((time) => Number.isFinite(time));
        });

        WATER_LEVER_ORDER.forEach((key) => {
            if (key === 'water') return;
            const times = solution[key];
            if (!this.isWaterLeverActive(transform, variant, key)) return;
            if (!times.length || times[0] !== 0) times.unshift(0);
            else times.shift();
        });

        return solution;
    }

    isWaterLeverActive(transform, variant, key) {
        const lever = WATER_LEVER_TYPES[key];
        if (!lever || !lever.initial) return false;
        const offset = lever.initial[variant - 1];
        if (!offset) return false;
        const pos = this.fromComp(transform, WATER_ENTRANCE.x + offset.x, WATER_ENTRANCE.y + offset.y, WATER_ENTRANCE.z + offset.z);
        return !this.getBlockIdAt(pos.x, pos.y, pos.z).includes(lever.block);
    }

    updateWaterBoardTiming() {
        if (!this.solverEnabled('Water Board') || !this.waterSolution || !this.waterTransform) return;
        const entries = this.getWaterScheduleEntries();
        this.waterTargets = entries;
        const next = entries[0];
        if (next?.ready && next?.pos && this.safeAutoClick('Water Board', next.pos, 0)) this.consumeWaterLeverClick(next.pos);
    }

    getWaterScheduleEntries() {
        if (!this.waterSolution || !this.waterTransform) return [];

        const now = Date.now();
        const entries = [];
        Object.entries(this.waterSolution).forEach(([key, times]) => {
            const lever = WATER_LEVER_TYPES[key];
            if (!lever || !Array.isArray(times)) return;
            times.forEach((time, index) => {
                const remaining = this.waterStartMillis ? this.waterStartMillis + time * 1000 - now : time * 1000;
                entries.push({
                    key,
                    lever,
                    time,
                    index,
                    remaining,
                    pos: this.fromComp(this.waterTransform, lever.pos.x, lever.pos.y, lever.pos.z),
                });
            });
        });

        entries.sort((a, b) => {
            const aOrder = a.time + (a.key === 'water' ? 0.001 : 0);
            const bOrder = b.time + (b.key === 'water' ? 0.001 : 0);
            if (aOrder !== bOrder) return aOrder - bOrder;
            return WATER_LEVER_ORDER.indexOf(a.key) - WATER_LEVER_ORDER.indexOf(b.key);
        });

        const nextKey = entries[0]?.key || null;
        entries.forEach((entry) => {
            const waitingForZeroLevers = entry.key === 'water' && entry.time === 0 && nextKey !== 'water';
            entry.ready = !waitingForZeroLevers && ((this.waterStartMillis === 0 && entry.time === 0) || (this.waterStartMillis > 0 && entry.remaining <= 0));
            entry.label = waitingForZeroLevers ? 'WAIT' : entry.ready ? 'CLICK' : this.waterStartMillis === 0 ? entry.time.toFixed(2) : Math.max(0, entry.remaining / 1000).toFixed(2);
        });

        return entries;
    }

    consumeWaterLeverClick(pos) {
        if (!this.waterSolution || !this.waterTransform || !pos) return false;
        const clicked = this.getWaterLeverKeyByActualPos(pos);
        if (!clicked) return false;

        const times = this.waterSolution[clicked];
        if (!Array.isArray(times)) return false;

        if (this.waterStartMillis === 0 && clicked !== 'water' && (!times.length || times[0] !== 0)) {
            times.unshift(0);
        } else {
            if (times.length) times.shift();
            if (this.waterStartMillis === 0 && clicked === 'water') this.waterStartMillis = Date.now();
        }

        this.updateWaterBoardTiming();
        return true;
    }

    getWaterLeverKeyByActualPos(pos) {
        const key = this.blockKey(pos);
        return WATER_LEVER_ORDER.find((leverKey) => {
            const lever = WATER_LEVER_TYPES[leverKey];
            if (!lever) return false;
            const actual = this.fromComp(this.waterTransform, lever.pos.x, lever.pos.y, lever.pos.z);
            return this.blockKey(actual) === key;
        }) || null;
    }

    renderWaterBoard() {
        const targets = Array.isArray(this.waterTargets) ? this.waterTargets : [];
        targets.forEach((target) => {
            if (!target || !target.pos) return;
            const rgb = target.lever?.color || [70, 150, 255];
            const alpha = target.ready ? 95 : 35;
            this.drawBlockTarget(target.pos, target.label || target.lever?.label || 'Lever', Render.Color(rgb[0], rgb[1], rgb[2], alpha), Render.Color(rgb[0], rgb[1], rgb[2], target.ready ? 255 : 150));
        });
    }

    updateTeleportMazeSolver() {
        const transform = this.bestTransformByProbes([
            { x: 4, y: 69, z: 6, any: TELEPORT_PAD_IDS },
            { x: 15, y: 69, z: 14, any: TELEPORT_PAD_IDS },
        ], 2);
        if (transform) {
            const key = `${transform.x}:${transform.z}:${transform.rotation}`;
            if (this.teleportPadsKey !== key || !this.teleportPads.length) {
                this.teleportKnownPads.clear();
                this.teleportFinalPad = null;
                this.teleportPads = TELEPORT_PAD_COMPS.map(([x, z, tx, tz, special = false, isEnd = false], index) => ({
                    rel: { x, y: 69, z },
                    pos: this.fromComp(transform, x, 69, z),
                    index,
                    special,
                    isEnd,
                })).filter((pad) => this.isRelevantRoomPos(pad.pos));
                this.teleportPadsKey = key;
                this.teleportTransform = transform;
            }
            this.updateTeleportFinalPad();
            this.setSolverHint('Teleport Maze', 'Skyblocker pad memory: used pads red, final unused pad green');
            return;
        }

        this.teleportPads = [];
        this.teleportPadsKey = null;
        this.teleportKnownPads.clear();
        this.teleportFinalPad = null;
        this.teleportTransform = null;
    }

    updateTeleportLearning() {
        if (!this.solverEnabled('Teleport Maze')) return;
        const playerPos = this.getPlayerPos();
        const last = this.teleportLastPos;
        this.teleportLastPos = playerPos;
        if (!last || !this.teleportPads.length || !this.teleportTransform || this.distanceSq(last, playerPos) < 16 * 16) return;

        const oldPad = this.nearestTeleportPad(last);
        const newPad = this.nearestTeleportPad(playerPos);
        if (!oldPad || !newPad || this.distanceSq(oldPad.pos, last) > 8 || this.distanceSq(newPad.pos, playerPos) > 30) return;
        this.teleportLastPad = newPad.pos;

        this.processSkyblockerTeleport(oldPad, playerPos);
        this.processSkyblockerTeleport(newPad, last);
        this.updateTeleportFinalPad();
    }

    nearestTeleportPad(pos) {
        return this.teleportPads.slice().sort((a, b) => this.distanceSq(a.pos, pos) - this.distanceSq(b.pos, pos))[0] || null;
    }

    processSkyblockerTeleport(fromPad, landingActualPos) {
        if (!fromPad || !landingActualPos || !this.teleportTransform) return;
        const roomType = this.getTeleportRoomType(landingActualPos);
        if (roomType) this.teleportKnownPads.set(this.blockKey(fromPad.pos), roomType);
    }

    getTeleportRoomType(actualPos) {
        const rel = this.toComp(this.teleportTransform, actualPos.x, 69, actualPos.z);
        const rx = Math.round(rel.x);
        const rz = Math.round(rel.z);
        if (rx === 15 && rz === 12) return 'ENTRANCE';

        const center = TELEPORT_ROOM_CENTERS.find((candidate) => rx >= candidate.x - 3 && rx <= candidate.x + 3 && rz >= candidate.z - 3 && rz <= candidate.z + 3);
        if (!center) return null;

        const actualCenter = this.fromComp(this.teleportTransform, center.x, center.y, center.z);
        const id = this.getBlockIdAt(actualCenter.x, actualCenter.y, actualCenter.z);
        const type = TELEPORT_ROOM_TYPES.find((entry) => id.includes(entry[1]));
        return type ? type[0] : null;
    }

    updateTeleportFinalPad() {
        if (!this.teleportPads.length) return;
        const candidates = this.teleportPads.filter((pad) => pad.rel.x !== 15 && !this.teleportKnownPads.has(this.blockKey(pad.pos)));
        this.teleportFinalPad = candidates.length === 1 ? candidates[0] : null;
    }

    renderTeleportMaze() {
        const pads = Array.isArray(this.teleportPads) ? this.teleportPads : [];
        pads.forEach((pad) => {
            if (!pad || !pad.pos) return;
            if (this.teleportFinalPad === pad) {
                this.drawBlockTarget(pad.pos, 'Final', Render.Color(80, 255, 120, 95), Render.Color(80, 255, 120, 255));
                this.drawLine(this.getPlayerEye(), this.centerOf(pad.pos), Render.Color(80, 255, 120, 220), 2);
                return;
            }

            if (!this.teleportKnownPads.has(this.blockKey(pad.pos))) return;
            this.drawBlockTarget(pad.pos, '', Render.Color(255, 70, 70, 55), Render.Color(255, 70, 70, 220));
        });
    }

    updateBoulderSolver() {
        const target = this.findSkyblockerBoulderSolution();
        if (target) {
            this.boulderTarget = target;
            this.setSolverHint('Boulder', target.button ? 'Skyblocker A*: click highlighted button' : 'Skyblocker A*: follow the path');
            if (target.button) this.safeAutoClick('Boulder', target.button, 0);
            return;
        }

        this.boulderTarget = null;
    }

    renderBoulder() {
        const target = this.boulderTarget;
        if (!target) return;

        const points = Array.isArray(target.points) ? target.points : [];
        for (let i = 0; i < points.length - 1; i++) {
            this.drawLine(points[i], points[i + 1], Render.Color(255, 170, 60, 230), 5);
        }
        if (target.button) this.drawBlockTarget(target.button, 'Click', Render.Color(255, 80, 70, 90), Render.Color(255, 80, 70, 255));
    }

    findSkyblockerBoulderSolution() {
        let best = null;
        this.getRoomTransformCandidates().forEach((transform) => {
            if (!this.isBoulderPuzzleTransform(transform)) return;

            const board = this.buildSkyblockerBoulderBoard(transform);
            const path = this.solveBoulderAStar(board);
            if (!path?.length) return;

            const points = path.map((coord) => {
                const rel = this.boulderCellToRelative(coord[0], coord[1]);
                return this.centerOf(this.fromComp(transform, rel[0], rel[1], rel[2]));
            });
            let button = null;
            for (let i = 0; i < points.length - 1; i++) {
                button = this.checkButtonBlocksOnLine(points[i], points[i + 1]);
                if (button) break;
            }

            best = { points, button };
        });
        return best;
    }

    buildSkyblockerBoulderBoard(transform) {
        const height = 8;
        const width = 7;
        const grid = Array.from({ length: height }, () => Array(width).fill('.'));
        for (let col = 0; col < width; col++) {
            grid[0][col] = col === Math.floor(width / 2) ? 'T' : 'B';
            grid[height - 1][col] = 'P';
        }

        let rowIndex = 1;
        for (let z = 25; z > 8; z--) {
            let colIndex = 0;
            for (let x = 25; x > 5; x--) {
                if (Math.abs(25 - x) % 3 === 1 && Math.abs(25 - z) % 3 === 1) {
                    const pos = this.fromComp(transform, x, 65, z);
                    const id = this.getBlockIdAt(pos.x, pos.y, pos.z);
                    grid[rowIndex][colIndex] = id.includes('birch_planks') || id.includes('jungle_planks') ? 'B' : '.';
                    colIndex++;
                }
            }
            if (colIndex === width) rowIndex++;
        }

        return grid;
    }

    solveBoulderAStar(grid) {
        const initial = [];
        for (let col = 0; col < grid[0].length; col++) initial.push({ grid: this.copyGrid(grid), row: grid.length - 1, col, path: [] });

        const queue = initial;
        const visited = new Set();
        let iterations = 0;

        while (queue.length && iterations < 10000) {
            queue.sort((a, b) => a.path.length + this.boulderHeuristic(a) - (b.path.length + this.boulderHeuristic(b)));
            const state = queue.shift();
            if (state.grid[state.row][state.col] === 'T') return state.path;

            const key = `${state.row}:${state.col}:${state.grid.map((row) => row.join('')).join('|')}`;
            if (visited.has(key)) continue;
            visited.add(key);

            const path = state.path.concat([[state.row, state.col]]);
            const moves = [
                [-1, 0],
                [0, -1],
                [0, 1],
                [1, 0],
            ];
            moves.forEach((move) => {
                const next = this.moveBoulderState(state.grid, state.row, state.col, move[0], move[1]);
                if (next) queue.push({ grid: next.grid, row: next.row, col: next.col, path });
            });
            iterations++;
        }

        return null;
    }

    moveBoulderState(grid, row, col, dr, dc) {
        const newRow = row + dr;
        const newCol = col + dc;
        if (!this.inBoulderBounds(grid, newRow, newCol)) return null;

        const nextGrid = this.copyGrid(grid);
        if (nextGrid[newRow][newCol] === 'B') {
            const boxRow = newRow + dr;
            const boxCol = newCol + dc;
            if (!this.inBoulderBounds(nextGrid, boxRow, boxCol) || nextGrid[boxRow][boxCol] !== '.') return null;
            nextGrid[newRow][newCol] = '.';
            nextGrid[boxRow][boxCol] = 'B';
        }

        return { grid: nextGrid, row: newRow, col: newCol };
    }

    inBoulderBounds(grid, row, col) {
        return row >= 0 && col >= 0 && row < grid.length && col < grid[0].length;
    }

    boulderHeuristic(state) {
        for (let row = 0; row < state.grid.length; row++) {
            for (let col = 0; col < state.grid[row].length; col++) {
                if (state.grid[row][col] === 'T') return Math.abs(state.row - row) + Math.abs(state.col - col);
            }
        }
        return 9999;
    }

    copyGrid(grid) {
        return grid.map((row) => row.slice());
    }

    boulderCellToRelative(row, col) {
        if (row === 0 && col === 3) return [15, 64, 29];
        return [24 - 3 * col, 64, 27 - 3 * row];
    }

    checkButtonBlocksOnLine(point1, point2) {
        const x1 = point1.x;
        const y1 = point1.y + 1;
        const z1 = point1.z;
        const x2 = point2.x;
        const y2 = point2.y + 1;
        const z2 = point2.z;
        const steps = Math.max(1, Math.floor(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), Math.abs(z2 - z1))));

        for (let step = 0; step <= steps; step++) {
            const pos = {
                x: Math.floor(x1 + ((x2 - x1) / steps) * step),
                y: Math.floor(y1 + ((y2 - y1) / steps) * step),
                z: Math.floor(z1 + ((z2 - z1) / steps) * step),
            };
            if (this.getBlockIdAt(pos.x, pos.y, pos.z).includes('stone_button')) return pos;
        }
        return null;
    }

    isBoulderPuzzleTransform(transform) {
        const chest = this.fromComp(transform, 15, 65, 29);
        const chestAbove = this.fromComp(transform, 15, 66, 29);
        return this.getBlockIdAt(chest.x, chest.y, chest.z).includes('chest') || this.getBlockIdAt(chestAbove.x, chestAbove.y, chestAbove.z).includes('chest');
    }

    updateIceFillSolver() {
        const paths = this.findIceFillPaths();
        this.iceFillPath = paths;
        if (paths.length) this.setSolverHint('Ice Fill', 'Follow highlighted ice path');
    }

    findIceFillPaths() {
        const transform = this.bestTransformByProbes([
            { x: 16, y: 69, z: 9, any: ICE_IDS },
            { x: 17, y: 70, z: 16, any: ICE_IDS },
            { x: 18, y: 71, z: 25, any: ICE_IDS },
        ], 2);
        if (!transform) return [];

        return ICE_FILL_BOARD_ORIGINS.map((origin) => this.solveIceFillBoard(transform, origin)).filter((path) => path.length);
    }

    solveIceFillBoard(transform, origin) {
        const size = origin.size;
        const board = Array.from({ length: size }, () => Array(size).fill(false));
        let changed = false;

        for (let row = 0; row < size; row++) {
            for (let col = 0; col < size; col++) {
                const pos = this.fromComp(transform, origin.x - col, origin.y, origin.z - row);
                const below = this.fromComp(transform, origin.x - col, origin.y - 1, origin.z - row);
                if (this.isAirId(this.getBlockIdAt(below.x, below.y, below.z))) return [];
                const blocked = !this.isAirId(this.getBlockIdAt(pos.x, pos.y, pos.z));
                board[row][col] = blocked;
                changed = changed || !blocked;
            }
        }

        if (!changed) return [];
        const path = this.solveIceFillDfs(board);
        return path.map((coord) => this.fromComp(transform, origin.x - coord[1], origin.y, origin.z - coord[0]));
    }

    solveIceFillDfs(board) {
        const size = board.length;
        const start = [size - 1, Math.floor(size / 2)];
        const totalOpen = board.reduce((sum, row) => sum + row.filter((blocked) => !blocked).length, 0);
        if (!totalOpen || board[start[0]][start[1]]) return [];

        const visited = Array.from({ length: size }, () => Array(size).fill(false));
        visited[start[0]][start[1]] = true;
        const path = [start];
        const deadline = Date.now() + ICE_FILL_SOLVE_BUDGET_MS;

        const dfs = (remaining) => {
            const [row, col] = path[path.length - 1];
            if (Date.now() > deadline) return false;
            if (remaining === 0) return row === 0 && col === Math.floor(size / 2);

            const moves = [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ];
            for (const move of moves) {
                const nr = row + move[0];
                const nc = col + move[1];
                if (nr < 0 || nc < 0 || nr >= size || nc >= size || board[nr][nc] || visited[nr][nc]) continue;
                visited[nr][nc] = true;
                path.push([nr, nc]);
                if (dfs(remaining - 1)) return true;
                path.pop();
                visited[nr][nc] = false;
            }
            return false;
        };

        return dfs(totalOpen - 1) ? path.slice() : [];
    }

    renderIceFill() {
        const raw = Array.isArray(this.iceFillPath) ? this.iceFillPath : [];
        const paths = Array.isArray(raw[0]) ? raw : [raw];
        paths.forEach((path) => {
            path.forEach((tile, index) => {
                if (!tile) return;
                const alpha = Math.max(35, 115 - index * 3);
                this.drawBlockTarget(tile, index === 0 ? 'Start' : '', Render.Color(80, 220, 255, alpha), Render.Color(80, 220, 255, 210));
                if (index > 0 && path[index - 1]) this.drawLine(this.centerOf(path[index - 1]), this.centerOf(tile), Render.Color(80, 220, 255, 180), 2);
            });
        });
    }

    updateIcePathSolver() {
        const silverfish = this.findSilverfishEntity();
        if (!silverfish) {
            this.icePathTarget = null;
            return;
        }

        const entityPos = this.getEntityPos(silverfish);
        const transform = this.getRoomTransformCandidates().find((candidate) => {
            const rel = this.toComp(candidate, Math.floor(entityPos.x), 66, Math.floor(entityPos.z));
            const row = 24 - Math.round(rel.z);
            const col = 23 - Math.round(rel.x);
            return row >= 0 && row < 17 && col >= 0 && col < 17;
        });
        if (!transform) {
            this.icePathTarget = null;
            return;
        }

        const rel = this.toComp(transform, Math.floor(entityPos.x), 66, Math.floor(entityPos.z));
        const start = [24 - Math.round(rel.z), 23 - Math.round(rel.x)];
        if (start[0] < 0 || start[0] >= 17 || start[1] < 0 || start[1] >= 17) {
            this.icePathTarget = null;
            return;
        }

        const board = [];
        for (let row = 0; row < 17; row++) {
            const cells = [];
            for (let col = 0; col < 17; col++) {
                const pos = this.fromComp(transform, 23 - col, 67, 24 - row);
                cells.push(!this.isAirId(this.getBlockIdAt(pos.x, pos.y, pos.z)));
            }
            board.push(cells);
        }

        const path = this.solveSkyblockerIcePath(board, start);
        this.icePathTarget = path.length
            ? {
                  path: path.map((coord) => this.centerOf(this.fromComp(transform, 23 - coord[1], 67, 24 - coord[0]))),
                  entity: silverfish,
              }
            : null;
        if (this.icePathTarget) this.setSolverHint('Ice Path', 'Skyblocker silverfish slide route');
    }

    renderIcePath() {
        const target = this.icePathTarget;
        if (!target) return;
        const path = Array.isArray(target.path) ? target.path : [];
        for (let i = 0; i < path.length - 1; i++) {
            this.drawLine(path[i], path[i + 1], Render.Color(255, 80, 80, 240), 5);
        }
        if (target.entity) this.drawEntityHitbox(target.entity, Render.Color(255, 80, 80, 255), 4);
    }

    findSilverfishEntity() {
        return (World.getAllEntities() || []).find((entity) => {
            if (!entity || entity.isDead?.() || this.isArmorStandEntity(entity)) return false;
            const clean = this.cleanText(entity.getName?.() || '').toLowerCase();
            if (clean.includes('silverfish')) return true;
            try {
                return String((entity?.toMC?.() || entity)?.getClass?.()?.getName?.() || '').includes('Silverfish');
            } catch (e) {
                return false;
            }
        }) || null;
    }

    solveSkyblockerIcePath(board, start) {
        const queue = [[start]];
        const visited = new Set([start.join(':')]);

        while (queue.length) {
            const path = queue.shift();
            const [row, col] = path[path.length - 1];
            if (row === 0 && col >= 7 && col <= 9) return path;

            [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ].forEach((move) => {
                const dr = move[0];
                const dc = move[1];
                let nr = row;
                let nc = col;
                while (nr >= 0 && nc >= 0 && nr < 17 && nc < 17 && !board[nr][nc]) {
                    nr += dr;
                    nc += dc;
                }
                nr -= dr;
                nc -= dc;
                const key = `${nr}:${nc}`;
                if (visited.has(key)) return;
                visited.add(key);
                queue.push(path.concat([[nr, nc]]));
            });
        }

        return [];
    }

    updateCreeperBeamsSolver() {
        const base = this.findCreeperBeamBase();
        if (!base) {
            this.creeperBeamTargets = [];
            return;
        }

        const creeperPos = { x: base.x + 0.5, y: 75.75, z: base.z + 0.5 };
        const targets = this.findCreeperBeamTargets(base);
        const beams = this.findCreeperBeamLines(creeperPos, targets);
        this.creeperBeamTargets = beams.map((beam, index) => ({
            start: beam.start,
            end: beam.end,
            color: CREEPER_COLORS[index % CREEPER_COLORS.length],
            done: this.getBlockIdAt(beam.start.x, beam.start.y, beam.start.z).includes('prismarine') && this.getBlockIdAt(beam.end.x, beam.end.y, beam.end.z).includes('prismarine'),
        }));
        if (this.creeperBeamTargets.length) this.setSolverHint('Creeper Beams', 'Skyblocker closest non-overlapping sea-lantern beams');
    }

    renderCreeperBeams() {
        const targets = Array.isArray(this.creeperBeamTargets) ? this.creeperBeamTargets : [];
        targets.forEach((target) => {
            if (!target) return;
            if (target.start && target.end) {
                const rgb = target.done ? [80, 255, 120] : target.color || [120, 255, 100];
                this.drawBlockTarget(target.start, target.done ? '' : 'Beam', Render.Color(rgb[0], rgb[1], rgb[2], target.done ? 25 : 45), Render.Color(rgb[0], rgb[1], rgb[2], target.done ? 120 : 230));
                this.drawBlockTarget(target.end, '', Render.Color(rgb[0], rgb[1], rgb[2], target.done ? 25 : 35), Render.Color(rgb[0], rgb[1], rgb[2], target.done ? 120 : 200));
                this.drawLine(this.centerOf(target.start), this.centerOf(target.end), Render.Color(rgb[0], rgb[1], rgb[2], target.done ? 120 : 220), target.done ? 2 : 3);
                return;
            }
            if (!target.entity || target.entity.isDead?.()) return;
            this.drawEntityHitbox(target.entity, Render.Color(120, 255, 100, 255), 4);
            if (target.goal && target.pos) this.drawLine({ x: target.pos.x, y: target.pos.y + 1, z: target.pos.z }, this.centerOf(target.goal), Render.Color(120, 255, 100, 180), 2);
        });
    }

    findCreeperBeamBase() {
        const creepers = (World.getAllEntities() || []).filter((entity) => this.isCreeperEntity(entity));
        for (const creeper of creepers) {
            const pos = this.getEntityPos(creeper);
            if (!pos || !this.isRelevantRoomPos(pos)) continue;
            const base = { x: Math.floor(pos.x), y: 74, z: Math.floor(pos.z) };
            if (this.isCreeperBeamTargetBlock(base)) return base;
        }
        return null;
    }

    isCreeperEntity(entity) {
        if (!entity || entity.isDead?.() || this.isArmorStandEntity(entity)) return false;
        const clean = this.cleanText(entity.getName?.() || '').toLowerCase();
        if (clean === 'creeper' || clean.includes('creeper')) return true;
        try {
            return String((entity?.toMC?.() || entity)?.getClass?.()?.getName?.() || '').includes('Creeper');
        } catch (e) {
            return false;
        }
    }

    isCreeperBeamTargetBlock(pos) {
        const id = this.getBlockIdAt(pos.x, pos.y, pos.z);
        return id.includes('sea_lantern') || id.includes('prismarine');
    }

    findCreeperBeamTargets(base) {
        const targets = [];
        for (let x = base.x - 15; x <= base.x + 16; x++) {
            for (let y = 68; y <= 86; y++) {
                for (let z = base.z - 15; z <= base.z + 16; z++) {
                    const pos = { x, y, z };
                    if (this.isCreeperBeamTargetBlock(pos)) targets.push(pos);
                }
            }
        }
        return targets;
    }

    findCreeperBeamLines(creeperPos, targets) {
        const allLines = [];
        for (let i = 0; i < targets.length; i++) {
            for (let j = i + 1; j < targets.length; j++) {
                const beam = { start: targets[i], end: targets[j] };
                allLines.push({ beam, distance: this.distancePointToLine(creeperPos, this.centerOf(beam.start), this.centerOf(beam.end)) });
            }
        }

        allLines.sort((a, b) => a.distance - b.distance);
        const result = [];
        while (result.length < 5 && allLines.length) {
            const solution = allLines.shift().beam;
            result.push(solution);
            allLines.splice(0, allLines.length, ...allLines.filter((entry) => !this.creeperBeamSharesTarget(solution, entry.beam)));
        }
        return result;
    }

    creeperBeamSharesTarget(a, b) {
        const a1 = this.blockKey(a.start);
        const a2 = this.blockKey(a.end);
        const b1 = this.blockKey(b.start);
        const b2 = this.blockKey(b.end);
        return a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2;
    }

    distancePointToLine(point, a, b) {
        const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const ap = { x: point.x - a.x, y: point.y - a.y, z: point.z - a.z };
        const cross = {
            x: ap.y * ab.z - ap.z * ab.y,
            y: ap.z * ab.x - ap.x * ab.z,
            z: ap.x * ab.y - ap.y * ab.x,
        };
        const crossLen = Math.sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z);
        const abLen = Math.sqrt(ab.x * ab.x + ab.y * ab.y + ab.z * ab.z) || 1;
        return crossLen / abLen;
    }

    safeAutoClick(source, pos, delay = 0) {
        if (!this.autoInteract || !pos) return false;
        const now = Date.now();
        if (now - this.lastAutoClick < AUTO_CLICK_COOLDOWN_MS) return false;
        if (!this.isRelevantRoomPos(pos)) return false;
        if (this.distanceSq(this.centerOf(pos), this.getPlayerEye()) > CLICK_RANGE_SQ) return false;

        this.lastAutoClick = now;
        this.setSolverHint(source, 'Auto-clicking solved target');
        this.rightClickBlock(pos, delay);
        return true;
    }

    rightClickBlock(pos, delay = 0) {
        const action = () => {
            try {
                const bp = new net.minecraft.util.math.BlockPos(pos.x, pos.y, pos.z);
                const vec = new Vec3d(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
                const hit = new BlockHitResult(vec, this.getHitDirectionForBlock(pos), bp, false);
                Client.sendPacket(new PlayerInteractBlockC2S(MCHand.MAIN_HAND, hit, 0));
            } catch (e) {
                console.error('V5 DungeonUtils right click error: ' + e + (e && e.stack ? e.stack : ''));
            }
        };

        if (delay > 0) ScheduleTask(delay, action);
        else action();
    }

    getHitDirectionForBlock(pos) {
        const eye = this.getPlayerEye();
        const center = this.centerOf(pos);
        const dx = eye.x - center.x;
        const dy = eye.y - center.y;
        const dz = eye.z - center.z;
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        const az = Math.abs(dz);

        if (ax >= ay && ax >= az) return dx >= 0 ? Direction.EAST : Direction.WEST;
        if (az >= ax && az >= ay) return dz >= 0 ? Direction.SOUTH : Direction.NORTH;
        return dy >= 0 ? Direction.UP : Direction.DOWN;
    }

    findNearbyBlocks(center, radius, predicate) {
        const blocks = [];
        const cappedRadius = Math.min(radius, MAX_BLOCK_SCAN_RADIUS);
        const baseX = Math.floor(center.x);
        const baseY = Math.floor(center.y);
        const baseZ = Math.floor(center.z);
        const ySpread = cappedRadius <= 8 ? Math.min(cappedRadius, 6) : 8;

        for (let x = baseX - cappedRadius; x <= baseX + cappedRadius; x++) {
            for (let y = baseY - ySpread; y <= baseY + ySpread; y++) {
                for (let z = baseZ - cappedRadius; z <= baseZ + cappedRadius; z++) {
                    const pos = { x, y, z };
                    const block = World.getBlockAt(x, y, z);
                    if (block && predicate(block, pos)) blocks.push(pos);
                }
            }
        }

        return blocks;
    }

    findNearestButton(center, radius) {
        const buttons = this.findNearbyBlocks(center, radius, (block) => this.idMatches(this.getBlockId(block), BUTTON_IDS));
        buttons.sort((a, b) => this.distanceSq(a, center) - this.distanceSq(b, center));
        return buttons[0] || null;
    }

    getArmorStands() {
        try {
            const typed = World.getAllEntitiesOfType(ArmorStandEntity) || [];
            if (typed.length) return typed;
        } catch (e) {}
        return (World.getAllEntities() || []).filter((entity) => this.isArmorStandEntity(entity));
    }

    findMobBelowNametag(stand, allEntities) {
        const standPos = this.getEntityPos(stand);
        if (!standPos) return null;

        let best = null;
        let bestScore = Infinity;
        allEntities.forEach((entity) => {
            if (!entity || entity === stand || entity.isDead?.() || this.isArmorStandEntity(entity) || this.isLikelyPlayer(entity)) return;

            const pos = this.getEntityPos(entity);
            if (!pos) return;

            const height = typeof entity.getHeight === 'function' ? entity.getHeight() : 2.0;
            const horizontalSq = (pos.x - standPos.x) * (pos.x - standPos.x) + (pos.z - standPos.z) * (pos.z - standPos.z);
            const vertical = Math.abs(pos.y + height + 0.25 - standPos.y);
            if (horizontalSq > 5.0 || vertical > 3.5) return;

            const score = horizontalSq + vertical * 0.8;
            if (score < bestScore) {
                bestScore = score;
                best = entity;
            }
        });

        return best;
    }

    findNamedEntity(name) {
        const target = this.normalize(name);
        return (World.getAllEntities() || []).find((entity) => {
            const cleanName = this.normalize(entity?.getName?.() || '');
            return cleanName === target || cleanName.includes(target);
        });
    }

    isArmorStandEntity(entity) {
        try {
            const mcEntity = entity?.toMC?.() || entity;
            if (mcEntity instanceof ArmorStandEntity) return true;
            const className = String(mcEntity?.getClass?.()?.getName?.() || '');
            if (className.includes('ArmorStand')) return true;
        } catch (e) {}
        return this.cleanText(entity?.getName?.() || '') === 'Armor Stand';
    }

    isLikelyPlayer(entity) {
        try {
            const className = String((entity?.toMC?.() || entity)?.getClass?.()?.getName?.() || '');
            if (className.includes('PlayerEntity') || className.includes('EntityPlayer') || className.includes('ClientPlayer')) return true;
        } catch (e) {
        }
        return false;
    }

    drawBlockTarget(pos, label, fill, line) {
        if (!pos) return;
        Render.drawStyledBox(new Vec3d(pos.x, pos.y, pos.z), fill, line, 4, false);
        if (label) this.drawText(label, { x: pos.x + 0.5, y: pos.y + 1.2, z: pos.z + 0.5 }, 0.95);
    }

    drawEntityHitbox(entity, color, thickness = 4) {
        try {
            Render.drawHitbox(entity?.toMC?.() || entity, color, thickness, false);
        } catch (e) {
            const pos = this.getEntityPos(entity);
            if (!pos) return;
            const width = typeof entity.getWidth === 'function' ? entity.getWidth() : 0.8;
            const height = typeof entity.getHeight === 'function' ? entity.getHeight() : 2.0;
            Render.drawSizedBox(new Vec3d(pos.x, pos.y, pos.z), width, height, width, color, false, thickness, false);
        }
    }

    drawText(text, pos, scale = 1) {
        if (!pos) return;
        Render.drawText(String(text), new Vec3d(pos.x, pos.y, pos.z), scale, true, false, true);
    }

    drawLine(start, end, color, thickness = 3) {
        if (!start || !end) return;
        Render.drawLine(new Vec3d(start.x, start.y, start.z), new Vec3d(end.x, end.y, end.z), color, thickness, false);
    }

    getBlockId(block) {
        return String(block?.type?.getRegistryName?.() || '').toLowerCase();
    }

    getBlockIdAt(x, y, z) {
        return this.getBlockId(World.getBlockAt(Math.floor(x), Math.floor(y), Math.floor(z)));
    }

    idMatches(id, parts) {
        return parts.some((part) => String(id || '').includes(part));
    }

    getPoweredState(pos) {
        try {
            const mcBlock = World.getBlockAt(pos.x, pos.y, pos.z)?.toMC?.();
            const state = mcBlock?.getBlockState?.();
            const entries = state?.getEntries?.();
            if (entries) {
                const iterator = entries.entrySet().iterator();
                while (iterator.hasNext()) {
                    const entry = iterator.next();
                    if (String(entry.getKey()).toLowerCase().includes('powered')) return String(entry.getValue()) === 'true';
                }
            }
        } catch (e) {}
        return null;
    }

    parseSkyblockHealth(text) {
        const numbers = String(text).match(/\d[\d,]*/g) || [];
        return numbers
            .map((value) => Number(value.replace(/,/g, '')))
            .filter((value) => Number.isFinite(value))
            .reduce((max, value) => Math.max(max, value), 0);
    }

    parseBlazeHealth(text) {
        const raw = String(text || '');
        const afterSlash = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
        const number = (afterSlash.match(/\d[\d,]*/g) || []).pop();
        return number ? Number(number.replace(/,/g, '')) || 0 : 0;
    }

    cleanMobLabel(label) {
        let clean = ChatLib.removeFormatting(String(label || 'Starred Mob')).trim();
        clean = clean
            .split('')
            .filter((char) => !STAR_MARKERS.includes(char.charCodeAt(0)) && char.charCodeAt(0) !== 0x2764)
            .join('');
        return clean
            .replace(/\b\d[\d,]*(?:\/\d[\d,]*)?\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    getEntityKey(entity) {
        try {
            const uuid = entity?.getUUID?.();
            if (uuid) return String(uuid);
        } catch (e) {}
        try {
            const mcEntity = entity?.toMC?.() || entity;
            if (typeof mcEntity?.getId === 'function') return String(mcEntity.getId());
        } catch (e) {}
        return null;
    }

    getEntityPos(entity) {
        if (!entity) return null;
        const pos = {
            x: Number(entity.getX?.() ?? entity.x),
            y: Number(entity.getY?.() ?? entity.y),
            z: Number(entity.getZ?.() ?? entity.z),
        };
        return Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z) ? pos : null;
    }

    getPlayerPos() {
        return { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
    }

    getPlayerEye() {
        return { x: Player.getX(), y: Player.getY() + 1.62, z: Player.getZ() };
    }

    centerOf(pos) {
        return { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
    }

    averagePos(positions) {
        if (!positions.length) return this.getPlayerPos();
        return {
            x: positions.reduce((sum, pos) => sum + pos.x, 0) / positions.length,
            y: positions.reduce((sum, pos) => sum + pos.y, 0) / positions.length,
            z: positions.reduce((sum, pos) => sum + pos.z, 0) / positions.length,
        };
    }

    blockKey(pos) {
        return `${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}`;
    }

    distanceSq(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return dx * dx + dy * dy + dz * dz;
    }

    horizontalDistanceSq(a, b) {
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        return dx * dx + dz * dz;
    }

    normalize(text) {
        return ChatLib.removeFormatting(String(text || ''))
            .toLowerCase()
            .replace(/[\u24d0-\u24e9]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    printPuzzleGuides() {
        this.message('&dActive Catacombs puzzle solvers:');
        PUZZLE_GUIDES.forEach(([name, guide]) => ChatLib.chat(`&d${name}: &f${guide}`));
    }

    setSolverHint(puzzle, hint) {
        this.activePuzzle = puzzle || 'None';
        this.solverHint = hint || 'No active puzzle hint';
    }

    clearSolverTargets() {
        this.weirdoChest = null;
        this.quizTargets = [];
        this.blazeTarget = null;
        this.blazeTargetHealth = null;
        this.blazeNextTarget = null;
        this.blazeNextHealth = null;
        this.clearWorldScanTargets();
    }

    clearWorldScanTargets() {
        this.ticTacToeTarget = null;
        this.resetWaterBoardState();
        this.teleportPads = [];
        this.teleportPadsKey = null;
        this.teleportKnownPads.clear();
        this.teleportFinalPad = null;
        this.teleportTransform = null;
        this.boulderTarget = null;
        this.iceFillPath = [];
        this.icePathTarget = null;
        this.creeperBeamTargets = [];
    }

    clearHeavyScanTargets() {
        this.resetWaterBoardState();
        this.teleportPads = [];
        this.teleportPadsKey = null;
        this.teleportKnownPads.clear();
        this.teleportFinalPad = null;
        this.teleportTransform = null;
        this.boulderTarget = null;
        this.iceFillPath = [];
        this.creeperBeamTargets = [];
    }

    clearRuntimeTargets() {
        this.starredMobs = [];
        this.clearSolverTargets();
    }

    resetRun() {
        this.roomBounds = null;
        this.roomBoundsAt = 0;
        this.roomBoundsSource = 'none';
        this.roomTransform = null;
        this.roomTransformKey = null;
        this.roomTransformAt = 0;
        this.lastRoomKey = null;
        this.nextWorldScanAt = 0;
        this.nextLightSolverScanAt = 0;
        this.activePuzzle = 'None';
        this.solverHint = 'No active puzzle hint';
        this.weirdoStatements.clear();
        this.weirdoSolvedAt = 0;
        this.quizAnswers = [];
        this.quizTargets = [];
        this.quizCurrentAnswerLetter = null;
        this.quizOptionAnswers.clear();
        this.teleportLastPos = null;
        this.teleportLastPad = null;
        this.teleportPadsKey = null;
        this.teleportKnownPads.clear();
        this.teleportFinalPad = null;
        this.teleportTransform = null;
        this.clearRuntimeTargets();
    }

    onDisable() {
        this.resetRun();
    }
}

try {
    new DungeonUtils();
} catch (e) {
    console.error('V5 DungeonUtils load error: ' + e + (e && e.stack ? e.stack : ''));
}
