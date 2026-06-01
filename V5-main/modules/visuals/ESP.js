import { Vec3d } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import Render from '../../utils/render/Render';

class ESP extends ModuleBase {
    constructor() {
        super({
            name: 'Player ESP',
            subcategory: 'Visuals',
            description: 'Shows players through walls',
            tooltip: 'Shows players through walls',
        });

        this.rgba = Render.Color(255, 0, 0, 255);

        this.showNames = false;
        this.disableEspWithinDistance = 2;
        this.players = [];
        this.lastPlayerRefreshAt = 0;

        this.addToggle(
            'Show Names',
            (value) => {
                this.showNames = value;
            },
            'Shows player names',
            true
        );

        this.addColorPicker(
            'ESP Color',
            java.awt.Color.RED,
            (color) => {
                this.rgba = Render.Color(color.getRed(), color.getGreen(), color.getBlue(), color.getAlpha());
            },
            'Color of the ESP box'
        );

        this.addSlider(
            'Disable ESP Distance',
            0,
            10,
            this.disableEspWithinDistance,
            (value) => {
                this.disableEspWithinDistance = value;
            },
            'Disables ESP for players within this many blocks of you'
        );

        this.on('postRenderWorld', () => {
            const self = Player.getPlayer();
            if (!self) return;

            const now = Date.now();
            if (now - this.lastPlayerRefreshAt > 250) {
                this.players = World.getAllPlayers();
                this.lastPlayerRefreshAt = now;
            }
            const disableEspWithinDistanceSq = this.disableEspWithinDistance * this.disableEspWithinDistance;

            for (const player of this.players) {
                if (player.getUUID().equals(Player.getUUID())) continue;
                if (player.getUUID().version() !== 4) continue;

                const entity = player.toMC();
                const distanceSq = self.squaredDistanceTo(entity);

                if (distanceSq <= disableEspWithinDistanceSq) continue;

                Render.drawHitbox(entity, this.rgba, 4, false);

                if (!this.showNames) continue;

                const canSee = self.canSee(entity);
                const maxDefaultNametagDistance = canSee ? 64 : 32;
                const maxDefaultNametagDistanceSq = maxDefaultNametagDistance * maxDefaultNametagDistance;

                if (distanceSq <= maxDefaultNametagDistanceSq) continue;

                let vec = new Vec3d(player.x, player.y + 2.3, player.z);
                Render.drawText(player.getName(), vec, 1.2, true, false, true);
            }
        });
    }
}

new ESP();
