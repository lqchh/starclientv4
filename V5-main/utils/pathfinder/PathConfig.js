import { ModuleBase } from '../ModuleBase';
import { File, globalAssetsDir } from '../Constants';

class PathFindingConfig extends ModuleBase {
    constructor() {
        super({
            name: 'Pathfinding',
            subcategory: 'Core',
            description: 'Pathfinding Utilities',
            tooltip: 'Pathfinding Utilities',
            showEnabledToggle: false,
            hideInModules: true,
        });

        this.WARP_POINTS_DATA = this.loadWarpPoints();
        this.WARP_POINT_STATES = {};

        this.PATHFINDING_DEBUG = false;
        this.RENDER_KEY_NODES = false;
        this.RENDER_FLOATING_SPLINE = false;
        this.RENDER_LOOK_POINTS = false;
        this.WALKER_AOTE_ENABLED = false;
        this.WALKER_AOTE_COOLDOWN_TICKS = 12;
        this.MIN_PATHFINDER_MAX_COMPUTE = 50_000;
        this.MAX_PATHFINDER_MAX_COMPUTE = 5_000_000;
        this.DEFAULT_PATHFINDER_MAX_COMPUTE = 500_000;
        this.PATHFINDER_MAX_COMPUTE = this.DEFAULT_PATHFINDER_MAX_COMPUTE;

        this.addDirectToggle(
            'Pathfinding Debug',
            (value) => {
                this.PATHFINDING_DEBUG = value;
            },
            'Enables pathfinding debug mode',
            false,
            'Pathfinding'
        );

        this.addDirectToggle(
            'Render Key Nodes',
            (value) => {
                this.RENDER_KEY_NODES = value;
            },
            'Renders the key nodes of the path',
            false,
            'Pathfinding'
        );

        this.addDirectToggle(
            'Render Floating Spline',
            (value) => {
                this.RENDER_FLOATING_SPLINE = value;
            },
            'Renders the floating spline of the path',
            false,
            'Pathfinding'
        );

        this.addDirectToggle(
            'Render Look Points',
            (value) => {
                this.RENDER_LOOK_POINTS = value;
            },
            'Renders the look points of the path',
            false,
            'Pathfinding'
        );

        this.addDirectToggle(
            'Walker AOTE Enabled',
            (value) => {
                this.WALKER_AOTE_ENABLED = value;
            },
            'Allows path walker to use Aspect of the End/Void for forward teleports.',
            false,
            'Pathfinding'
        );

        this.addDirectSlider(
            'Walker AOTE Cooldown Ticks',
            5,
            20,
            12,
            (value) => {
                this.WALKER_AOTE_COOLDOWN_TICKS = Math.max(0, Math.floor(value));
            },
            'Ticks between AOTE/AOTV right clicks.',
            'Pathfinding'
        );

        this.addDirectSlider(
            'Pathfinder Max Compute',
            this.MIN_PATHFINDER_MAX_COMPUTE,
            this.MAX_PATHFINDER_MAX_COMPUTE,
            this.DEFAULT_PATHFINDER_MAX_COMPUTE,
            (value) => {
                this.PATHFINDER_MAX_COMPUTE = this.clampPathfinderMaxCompute(value);
            },
            'Maximum native pathfinder iterations before giving up.',
            'Pathfinding'
        );

        this.registerWarpPointSettings();
    }

    loadWarpPoints() {
        const warppointsloc = new File(globalAssetsDir, 'WarpPoints.json');
        const raw = FileLib.read(warppointsloc.getPath());
        try {
            const parsed = raw ? JSON.parse(raw) : null;
            const warps = Array.isArray(parsed?.warps) ? parsed.warps : [];
            return warps
                .map((warp) => ({
                    warp: typeof warp.warp === 'string' ? warp.warp.trim() : '',
                    area: typeof warp.area === 'string' ? warp.area.trim() : '',
                    defaultUnlock: !!warp.defaultUnlock,
                    x: Number(warp.x),
                    y: Number(warp.y),
                    z: Number(warp.z),
                }))
                .filter((warp) => warp.warp && warp.area && Number.isFinite(warp.x) && Number.isFinite(warp.y) && Number.isFinite(warp.z));
        } catch (e) {
            console.error('V5 Caught error' + e + e.stack);
            return [];
        }
    }

    clampPathfinderMaxCompute(value) {
        const parsed = Math.floor(Number(value));
        if (!Number.isFinite(parsed)) return this.DEFAULT_PATHFINDER_MAX_COMPUTE;
        return Math.max(this.MIN_PATHFINDER_MAX_COMPUTE, Math.min(this.MAX_PATHFINDER_MAX_COMPUTE, parsed));
    }

    registerWarpPointSettings() {
        this.WARP_POINTS_DATA.forEach((warpPoint) => {
            this.WARP_POINT_STATES[warpPoint.warp] = warpPoint.defaultUnlock;
        });

        const warpNames = this.WARP_POINTS_DATA.map((warpPoint) => warpPoint.warp);
        const defaultWarps = this.WARP_POINTS_DATA.filter((warpPoint) => warpPoint.defaultUnlock).map((warpPoint) => warpPoint.warp);

        this.addDirectMultiToggle(
            'Warp Points',
            warpNames,
            false,
            (value) => {
                this.toggleWarpPoint(value);
            },
            'Select which warps can be used as pathfinding start points',
            defaultWarps,
            'Pathfinding'
        );
    }

    toggleWarpPoint(value) {
        const enabledWarps = new Set();

        value.forEach((entry) => {
            if (entry.enabled) {
                enabledWarps.add(entry.name);
            }
        });

        this.WARP_POINTS_DATA.forEach((warpPoint) => {
            this.WARP_POINT_STATES[warpPoint.warp] = enabledWarps.has(warpPoint.warp);
        });
    }

    getAreaWarpPoints(area) {
        return this.WARP_POINTS_DATA.filter((warpPoint) => {
            if (!this.WARP_POINT_STATES[warpPoint.warp]) return false;
            return warpPoint.area === area;
        });
    }
}

const PathConfig = new PathFindingConfig();
export default PathConfig;
