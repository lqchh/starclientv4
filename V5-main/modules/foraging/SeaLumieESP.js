import { Vec3d } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { Utils } from '../../utils/Utils';
import Render from '../../utils/render/Render';

const SEA_PICKLE_ID = 'minecraft:sea_pickle';
const SCAN_RADIUS = 18;
const VERTICAL_RADIUS = 8;
const MAX_TARGETS = 120;

function isGalateaOrUnknown() {
    const area = Utils.area();
    return area === 'Galatea' || area === 'unknown';
}

function isSeaPickleBlock(x, y, z) {
    const block = World.getBlockAt(x, y, z);
    const registry = String(block?.type?.getRegistryName?.() || '').toLowerCase();
    const name = String(block?.type?.getName?.() || '').toLowerCase();

    return registry === SEA_PICKLE_ID || registry.includes('sea_pickle') || name.includes('sea pickle');
}

function buildScanOffsets() {
    const offsets = [];
    const radiusSq = SCAN_RADIUS * SCAN_RADIUS;

    for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
        for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
            const horizontalSq = dx * dx + dz * dz;
            if (horizontalSq > radiusSq) continue;

            for (let dy = -VERTICAL_RADIUS; dy <= VERTICAL_RADIUS; dy++) {
                offsets.push({
                    dx,
                    dy,
                    dz,
                    distSq: horizontalSq + dy * dy,
                });
            }
        }
    }

    offsets.sort((a, b) => a.distSq - b.distSq);
    return offsets;
}

const SCAN_OFFSETS = buildScanOffsets();

class SeaLumieESP extends ModuleBase {
    constructor() {
        super({
            name: 'Sea Lumie ESP',
            subcategory: 'Foraging',
            description: 'Highlights nearby Sea Lumie sea pickle blocks.',
            tooltip: 'Highlights nearby Sea Lumie sea pickle blocks.',
        });

        this.targets = [];
        this.fillColor = Render.Color(0, 190, 255, 90);
        this.nearestColor = Render.Color(80, 255, 190, 120);

        this.on('step', () => this.scanTargets()).setFps(5);

        this.when(
            () => this.enabled && World.isLoaded() && this.targets.length > 0,
            'postRenderWorld',
            () => this.renderTargets()
        );

        this.on('worldUnload', () => {
            this.targets = [];
        });
    }

    scanTargets() {
        if (!this.enabled || !World.isLoaded() || !isGalateaOrUnknown()) {
            this.targets = [];
            return;
        }

        const player = Player.getPlayer();
        if (!player) {
            this.targets = [];
            return;
        }

        const px = Math.floor(Player.getX());
        const py = Math.floor(Player.getY());
        const pz = Math.floor(Player.getZ());
        const targets = [];

        for (let i = 0; i < SCAN_OFFSETS.length && targets.length < MAX_TARGETS; i++) {
            const offset = SCAN_OFFSETS[i];
            const x = px + offset.dx;
            const y = py + offset.dy;
            const z = pz + offset.dz;

            if (!isSeaPickleBlock(x, y, z)) continue;
            targets.push({ x, y, z });
        }

        this.targets = targets;
    }

    getTargets() {
        if (this.enabled && World.isLoaded() && isGalateaOrUnknown()) {
            this.scanTargets();
        }

        this.targets = this.targets.filter((target) => isSeaPickleBlock(target.x, target.y, target.z));
        return this.targets.slice();
    }

    renderTargets() {
        this.targets = this.targets.filter((target) => isSeaPickleBlock(target.x, target.y, target.z));

        this.targets.forEach((target, index) => {
            const color = index === 0 ? this.nearestColor : this.fillColor;
            Render.drawBox(new Vec3d(target.x, target.y, target.z), color, false);
        });
    }

    onDisable() {
        this.targets = [];
    }
}

export const SeaLumieESPModule = new SeaLumieESP();

export function getSeaLumieTargets() {
    return SeaLumieESPModule.getTargets();
}
