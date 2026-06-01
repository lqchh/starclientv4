import { Vec3d } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { ParticleS2C } from '../../utils/Packets';
import Render from '../../utils/render/Render';

// Wilted Berberis are dead_bush blocks with purple particles around them.
// Only the bush currently emitting particles is the "active" one that can be harvested.
// The purple particles could be PORTAL, ENTITY_EFFECT, or WITCH depending on the server.
const PORTAL_PARTICLE = net.minecraft.particle.ParticleTypes.PORTAL;
const ENTITY_EFFECT_PARTICLE = net.minecraft.particle.ParticleTypes.ENTITY_EFFECT;
const WITCH_PARTICLE = net.minecraft.particle.ParticleTypes.WITCH;
const BERBERIS_BLOCK_ID = 'minecraft:dead_bush';

// Max distance from player to detect particles
const MAX_DETECTION_RADIUS = 15;
// How long an active berberis stays tracked before expiring (particles refresh it)
const ACTIVE_EXPIRE_MS = 5000;
// Minimum particle hits to confirm
const PARTICLE_CONFIRM_THRESHOLD = 2;

class WiltedBerberisESP extends ModuleBase {
    constructor() {
        super({
            name: 'Wilted Berberis ESP',
            subcategory: 'Farming',
            description: 'Highlights the currently active Wilted Berberis (the one with purple particles).',
            tooltip: 'Detects purple particles on dead_bush blocks to find the active Wilted Berberis.',
        });

        // Map<key, { x, y, z, expiresAt, particleCount }>
        this.activeBerberis = new Map();
        // Track the latest confirmed active target for the macro
        this.currentTarget = null;
        this.debugMode = false;
        this.lastDebugTime = 0;

        this.activeColor = Render.Color(180, 50, 255, 120);
        this.pendingColor = Render.Color(180, 50, 255, 40);
        this.tracerColor = Render.Color(200, 120, 255, 200);

        this.on('packetReceived', (packet) => this.onParticlePacket(packet)).setFilteredClass(ParticleS2C);
        this.on('tick', () => this.cleanup());
        this.on('worldLoad', () => this.clearAll());
        this.on('worldUnload', () => this.clearAll());

        this.when(
            () => this.enabled && this.activeBerberis.size > 0,
            'postRenderWorld',
            () => this.renderBerberis()
        );

        this.addToggle(
            'Debug Mode',
            (value) => {
                this.debugMode = value;
            },
            'Prints particle info to chat to help diagnose detection issues.',
            false
        );
    }

    onDisable() {
        this.clearAll();
    }

    clearAll() {
        this.activeBerberis.clear();
        this.currentTarget = null;
    }

    onParticlePacket(packet) {
        let particleType;
        try {
            particleType = packet.getParameters().getType();
        } catch (e) {
            return;
        }

        // Ignore particles too far from the player
        const px = packet.getX();
        const py = packet.getY();
        const pz = packet.getZ();
        const playerX = Player.getX();
        const playerY = Player.getY();
        const playerZ = Player.getZ();
        const distSq = (px - playerX) * (px - playerX) + (py - playerY) * (py - playerY) + (pz - playerZ) * (pz - playerZ);
        if (distSq > MAX_DETECTION_RADIUS * MAX_DETECTION_RADIUS) return;

        // Check if this is a purple-ish particle (try all known types)
        if (!this.isPurpleParticle(particleType)) {
            // Debug: log ALL particle types near dead bushes so we can find the right one
            if (this.debugMode) {
                const now = Date.now();
                if (now - this.lastDebugTime > 500) {
                    const x = packet.getX();
                    const y = packet.getY();
                    const z = packet.getZ();
                    const bx = Math.floor(x);
                    const by = Math.floor(y);
                    const bz = Math.floor(z);

                    // Check if any nearby block is a dead bush
                    const nearbyBush = this.findNearbyDeadBush(bx, by, bz);
                    if (nearbyBush) {
                        const typeName = this.getParticleTypeName(particleType);
                        this.message(`&eParticle near bush: &f${typeName} &eat &f${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);
                        this.lastDebugTime = now;
                    }
                }
            }
            return;
        }

        const x = px;
        const y = py;
        const z = pz;

        const bx = Math.floor(x);
        const by = Math.floor(y);
        const bz = Math.floor(z);

        // Find the dead_bush — check the exact position AND adjacent blocks
        // because particles float around the bush and may land on neighboring air blocks
        const bush = this.findNearbyDeadBush(bx, by, bz);
        if (!bush) {
            if (this.debugMode) {
                const now = Date.now();
                if (now - this.lastDebugTime > 1000) {
                    const typeName = this.getParticleTypeName(particleType);
                    const block = World.getBlockAt(bx, by, bz);
                    const reg = block?.type?.getRegistryName?.() || 'unknown';
                    this.message(`&6Purple particle but no bush: &f${typeName} &6at &f${bx},${by},${bz} &6block=&f${reg}`);
                    this.lastDebugTime = now;
                }
            }
            return;
        }

        if (this.debugMode) {
            const now = Date.now();
            if (now - this.lastDebugTime > 2000) {
                this.message(`&aFound active berberis at &f${bush.x}, ${bush.y}, ${bush.z}`);
                this.lastDebugTime = now;
            }
        }

        const now = Date.now();
        const key = `${bush.x}:${bush.y}:${bush.z}`;
        const existing = this.activeBerberis.get(key);

        if (existing) {
            existing.expiresAt = now + ACTIVE_EXPIRE_MS;
            existing.particleCount++;

            if (existing.particleCount >= PARTICLE_CONFIRM_THRESHOLD) {
                this.currentTarget = { x: bush.x, y: bush.y, z: bush.z };
            }
        } else {
            const entry = {
                x: bush.x,
                y: bush.y,
                z: bush.z,
                expiresAt: now + ACTIVE_EXPIRE_MS,
                particleCount: 1,
            };
            this.activeBerberis.set(key, entry);

            // If threshold is 1, immediately confirm
            if (PARTICLE_CONFIRM_THRESHOLD <= 1) {
                this.currentTarget = { x: bush.x, y: bush.y, z: bush.z };
            }
        }
    }

    isPurpleParticle(type) {
        if (!type) return false;
        try {
            if (type.equals(PORTAL_PARTICLE)) return true;
            if (type.equals(ENTITY_EFFECT_PARTICLE)) return true;
            if (type.equals(WITCH_PARTICLE)) return true;
        } catch (e) {
            // fallback: string check
        }

        try {
            const name = String(type).toLowerCase();
            if (name.includes('portal')) return true;
            if (name.includes('entity_effect')) return true;
            if (name.includes('witch')) return true;
        } catch (e) {
            // ignore
        }

        return false;
    }

    getParticleTypeName(type) {
        try {
            return String(type);
        } catch (e) {
            return 'unknown';
        }
    }

    /**
     * Search the block at (bx, by, bz) and all immediate neighbors for a dead_bush.
     * Returns { x, y, z } of the bush, or null.
     */
    findNearbyDeadBush(bx, by, bz) {
        // Check exact position first
        if (this.isDeadBush(bx, by, bz)) return { x: bx, y: by, z: bz };

        // Check all 26 neighbors (3x3x3 cube minus center)
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const nx = bx + dx;
                    const ny = by + dy;
                    const nz = bz + dz;
                    if (this.isDeadBush(nx, ny, nz)) return { x: nx, y: ny, z: nz };
                }
            }
        }

        return null;
    }

    isDeadBush(x, y, z) {
        const block = World.getBlockAt(x, y, z);
        const registry = block?.type?.getRegistryName?.();
        return registry === BERBERIS_BLOCK_ID;
    }

    cleanup() {
        if (!this.enabled || this.activeBerberis.size === 0) return;

        const now = Date.now();
        for (const [key, data] of this.activeBerberis.entries()) {
            if (data.expiresAt <= now) {
                this.activeBerberis.delete(key);
                if (this.currentTarget && this.currentTarget.x === data.x && this.currentTarget.y === data.y && this.currentTarget.z === data.z) {
                    this.currentTarget = null;
                }
                continue;
            }

            // Verify block still exists
            if (!this.isDeadBush(data.x, data.y, data.z)) {
                this.activeBerberis.delete(key);
                if (this.currentTarget && this.currentTarget.x === data.x && this.currentTarget.y === data.y && this.currentTarget.z === data.z) {
                    this.currentTarget = null;
                }
            }
        }
    }

    renderBerberis() {
        for (const data of this.activeBerberis.values()) {
            const isConfirmed = data.particleCount >= PARTICLE_CONFIRM_THRESHOLD;
            const pos = new Vec3d(data.x + 0.5, data.y + 0.001, data.z + 0.5);
            const color = isConfirmed ? this.activeColor : this.pendingColor;

            Render.drawSizedBox(pos, 0.5, 0.5, 0.5, color, true, 1, false);

            if (isConfirmed) {
                Render.drawTracer(new Vec3d(data.x + 0.5, data.y + 0.5, data.z + 0.5), this.tracerColor, 2, false);
            }
        }
    }
}

const WiltedBerberisESPModule = new WiltedBerberisESP();

/**
 * Returns the current confirmed active berberis target (the one with particles), or null.
 */
export function getActiveBerberis() {
    const target = WiltedBerberisESPModule.currentTarget;
    if (!target) return null;

    if (!WiltedBerberisESPModule.isDeadBush(target.x, target.y, target.z)) {
        WiltedBerberisESPModule.currentTarget = null;
        return null;
    }

    return { x: target.x, y: target.y, z: target.z };
}

/**
 * Returns all currently tracked berberis (both confirmed and pending).
 */
export function getTrackedWiltedBerberis() {
    return Array.from(WiltedBerberisESPModule.activeBerberis.values()).map((entry) => ({
        x: entry.x,
        y: entry.y,
        z: entry.z,
        confirmed: entry.particleCount >= PARTICLE_CONFIRM_THRESHOLD,
    }));
}

/**
 * Check if a block at the given coordinates is a dead_bush (potential berberis).
 */
export function isWiltedBerberisBlock(x, y, z) {
    return WiltedBerberisESPModule.isDeadBush(x, y, z);
}
