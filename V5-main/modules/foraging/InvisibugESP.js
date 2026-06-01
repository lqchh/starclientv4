import { ArmorStandEntity, Vec3d } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { ParticleS2C } from '../../utils/Packets';
import { ScheduleTask } from '../../utils/ScheduleTask';
import { Utils } from '../../utils/Utils';
import Render from '../../utils/render/Render';

const CRIT_PARTICLE = net.minecraft.particle.ParticleTypes.CRIT;
const DISTANCE = 5;
const SEE_DISTANCE = 32;
const DEFAULT_ARMOR_STAND_NAME = 'Armor Stand';

function isCompletelyDefaultArmorStand(entity) {
    if (!entity || entity.isDead()) return false;

    const name = ChatLib.removeFormatting(entity.getName() || '').trim();
    if (name !== DEFAULT_ARMOR_STAND_NAME) return false;

    for (let slot = 0; slot <= 5; slot++) {
        if (entity.getStackInSlot(slot)) return false;
    }

    return true;
}

function distanceTo(x, y, z, entity) {
    const dx = entity.getX() - x;
    const dy = entity.getY() - y;
    const dz = entity.getZ() - z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getNearestDefaultStandInBox(x, y, z, radius) {
    let nearest = null;
    let nearestDistance = radius;

    World.getAllEntitiesOfType(ArmorStandEntity).forEach((entity) => {
        if (!isCompletelyDefaultArmorStand(entity)) return;

        const dx = Math.abs(entity.getX() - x);
        const dy = Math.abs(entity.getY() - y);
        const dz = Math.abs(entity.getZ() - z);
        if (dx > radius || dy > radius || dz > radius) return;

        const dist = distanceTo(x, y, z, entity);
        if (dist < nearestDistance) {
            nearestDistance = dist;
            nearest = entity;
        }
    });

    return nearest;
}

function canBeSeen(entity, maxDistance) {
    if (!entity || entity.isDead()) return false;

    const player = Player.asPlayerMP();
    if (!player) return false;

    const dx = entity.getX() - Player.getX();
    const dy = entity.getY() - Player.getY();
    const dz = entity.getZ() - Player.getZ();
    if (dx * dx + dy * dy + dz * dz > maxDistance * maxDistance) return false;

    return player.canSeeEntity(entity);
}

function isCritParticleType(type) {
    if (!type) return false;
    try {
        return type.equals(CRIT_PARTICLE);
    } catch (e) {
        return String(type).toLowerCase().includes('crit');
    }
}

class InvisibugESP extends ModuleBase {
    constructor() {
        super({
            name: 'Invisibug ESP',
            subcategory: 'Foraging',
            description: 'Highlights Invisibugs on Galatea and draws tracers to them.',
            tooltip: 'Highlights Invisibugs on Galatea and draws tracers to them.',
        });

        this.invisibugEntities = new Map();
        this.locationsToRender = [];
        this.tickCounter = 0;

        this.fillColor = Render.Color(170, 85, 255, 70);
        this.tracerColor = Render.Color(170, 85, 255, 255);
        this.renderOffset = new Vec3d(0.4, -0.2, 0.4);

        this.on('packetReceived', (packet) => this.onParticlePacket(packet)).setFilteredClass(ParticleS2C);
        this.on('tick', () => this.onTick());
        this.on('entityDeath', (entity) => this.onEntityRemoved(entity));
        this.on('worldUnload', () => this.clearTargets());

        this.when(
            () => this.enabled && World.isLoaded() && Utils.area() === 'Galatea' && this.locationsToRender.length > 0,
            'postRenderWorld',
            () => this.renderTargets()
        );
    }

    isActive() {
        return this.enabled && World.isLoaded() && Utils.area() === 'Galatea';
    }

    clearTargets() {
        this.invisibugEntities.clear();
        this.locationsToRender = [];
    }

    hasTrackedEntityNear(x, y, z) {
        for (const entity of this.invisibugEntities.values()) {
            if (entity && !entity.isDead() && distanceTo(x, y, z, entity) < DISTANCE) return true;
        }
        return false;
    }

    onParticlePacket(packet) {
        if (!this.isActive()) return;

        try {
            if (!isCritParticleType(packet.getParameters().getType())) return;
        } catch (e) {
            return;
        }

        const x = packet.getX();
        const y = packet.getY();
        const z = packet.getZ();

        if (this.hasTrackedEntityNear(x, y, z)) return;

        const stand = getNearestDefaultStandInBox(x, y, z, DISTANCE);
        if (!stand) return;

        ScheduleTask(1, () => {
            if (!this.isActive() || !stand || stand.isDead() || !isCompletelyDefaultArmorStand(stand)) return;
            this.invisibugEntities.set(stand.getUUID().toString(), stand);
        });
    }

    onTick() {
        if (!this.isActive()) {
            this.clearTargets();
            return;
        }

        if (++this.tickCounter % 5 !== 0) return;

        for (const [id, entity] of this.invisibugEntities.entries()) {
            if (!entity || entity.isDead()) this.invisibugEntities.delete(id);
        }

        this.locationsToRender = [];

        for (const entity of this.invisibugEntities.values()) {
            if (!canBeSeen(entity, SEE_DISTANCE)) continue;
            this.locationsToRender.push({
                x: entity.getX(),
                y: entity.getY(),
                z: entity.getZ(),
            });
        }
    }

    onEntityRemoved(entity) {
        if (!entity) return;
        this.invisibugEntities.delete(entity.getUUID().toString());
    }

    renderTargets() {
        for (const location of this.locationsToRender) {
            const ox = location.x + this.renderOffset.x;
            const oy = location.y + this.renderOffset.y;
            const oz = location.z + this.renderOffset.z;
            const tracerPos = new Vec3d(ox, oy + 0.5, oz);

            Render.drawSizedBox(new Vec3d(ox, oy, oz), 0.4, 0.4, 0.4, this.fillColor, true, 2, false);
            Render.drawTracer(tracerPos, this.tracerColor, 2, false);
        }
    }

    onDisable() {
        this.clearTargets();
        this.tickCounter = 0;
    }
}

new InvisibugESP();
