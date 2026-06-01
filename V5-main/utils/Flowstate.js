import { Chat } from './Chat';
import { BlockUpdateS2C } from './Packets';

class FlowstateUtilsClass {
    constructor() {
        this.countdown = 0;
        this.multiplier = 1;
        this.flowstateBlocksBroken = 0;
        this.isMax = false;

        this.block = { x: 0, y: 0, z: 0 };
        this.currentBlock = null;
        this.cachedHeldKey = null;
        this.cachedHeldBonus = 0;

        register('playerInteract', (action, object) => {
            if (String(action) === 'AttackBlock') {
                const typeName = object?.type?.name ? String(object.type.name).toLowerCase() : '';
                if (typeName && !typeName.includes('bedrock')) {
                    this.block.x = object.getX();
                    this.block.y = object.getY();
                    this.block.z = object.getZ();
                    this.currentBlock = object;
                } else {
                    this.block.x = this.block.y = this.block.z = 0;
                }
            }
        });

        register('packetReceived', (packet) => {
            const pos = packet?.getPos?.();
            if (!pos) return;
            if (pos.getX() !== this.block.x || pos.getY() !== this.block.y || pos.getZ() !== this.block.z) return;

            const stateBlock = packet?.getState?.()?.getBlock?.()?.toString?.() || '';
            if (!stateBlock.includes('bedrock') && !stateBlock.includes('air')) return;

            const bonus = this.getHeldFlowstateBonus();
            if (bonus <= 0) return;

            this.flowstateBlocksBroken += bonus;
            this.countdown = 10;

            if (this.isMax) return;

            if (this.flowstateBlocksBroken > 100 * this.multiplier) {
                if (this.multiplier === 6) {
                    this.isMax = true;
                    return Chat.message('Reached max Flowstate!');
                }

                this.multiplier++;

                let rounded = Math.floor(this.flowstateBlocksBroken / 100) * 100;
                Chat.message(`Current Flowstate: ${rounded}`);
            }
        }).setFilteredClass(BlockUpdateS2C);

        register('step', () => {
            if (this.countdown === 0) {
                if (this.flowstateBlocksBroken > 100) {
                    Chat.message(`Flowstate lost at ${this.flowstateBlocksBroken} blocks`);
                }
                this.isMax = false;
                this.flowstateBlocksBroken = 0;
            }

            if (this.countdown > 0) this.countdown--;
            if (this.isMax) this.flowstateBlocksBroken = 600;
        }).setFps(1);
    }

    CurrentFlowstate() {
        return Math.min(600, this.flowstateBlocksBroken);
    }

    getHeldFlowstateBonus() {
        const held = Player.getHeldItem();
        if (!held) {
            this.cachedHeldKey = null;
            this.cachedHeldBonus = 0;
            return 0;
        }

        const key = `${held.getName?.() || ''}|${held.type?.getRegistryName?.() || ''}`;
        if (key === this.cachedHeldKey) return this.cachedHeldBonus;

        this.cachedHeldKey = key;
        this.cachedHeldBonus = 0;

        try {
            const lore = held
                .getLore()
                .map((l) => ChatLib.removeFormatting(l))
                .join(' ');
            const match = lore.match(/flowstate\s*(i{1,3})/i);
            const roman = { I: 1, II: 2, III: 3 };
            this.cachedHeldBonus = match ? roman[match[1].toUpperCase()] || 0 : 0;
        } catch (e) {
            this.cachedHeldBonus = 0;
        }

        return this.cachedHeldBonus;
    }
}

export const Flowstate = new FlowstateUtilsClass();
