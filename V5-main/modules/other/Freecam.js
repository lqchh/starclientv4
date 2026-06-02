import { Vec3d } from '../../utils/Constants';
import { Camera } from '../../utils/Camera';
import { MacroState } from '../../utils/MacroState';
import { Mixin } from '../../utils/MixinManager';
import { ModuleBase } from '../../utils/ModuleBase';
import { Keybind } from '../../utils/player/Keybinding';
import { mc } from '../../utils/Utils';

const Perspective = net.minecraft.client.option.Perspective;
const THIRD_PERSON_DISTANCE = 4.0;

class Freecam extends ModuleBase {
    constructor() {
        super({
            name: 'Freecam',
            subcategory: 'Visuals',
            description: 'Detach your camera and fly it around locally.',
            tooltip: 'Client-side freecam.',
            theme: '#5fb0ff',
            autoDisableOnWorldUnload: true,
            showEnabledToggle: false,
        });

        this.bindToggleKey();

        this.moveSpeed = 10;
        this.cameraPos = null;
        this.freecamYaw = 0;
        this.freecamPitch = 0;
        this.lastMouseX = null;
        this.lastMouseY = null;
        this.velocity = new Vec3d(0, 0, 0);
        this.savedPerspective = null;

        this.addSlider('Move Speed', 1, 30, 10, (value) => (this.moveSpeed = Number(value) / 25), 'Freecam move speed.');

        this.on('step', () => this.onTick()).setFps(100);
    }

    onEnable() {
        const player = Player.getPlayer();
        if (!World.isLoaded() || !player) {
            this.cameraPos = null;
            this.velocity = new Vec3d(0, 0, 0);
            this.savedPerspective = null;
            Mixin.set('freecamEnabled', false);
            Camera.clearCameraPosition();
            Mixin.delete('freecamFrozenYaw');
            Mixin.delete('freecamFrozenPitch');
            Mixin.delete('cameraOverrideYaw');
            Mixin.delete('cameraOverridePitch');
            return;
        }

        this.message('&aEnabled');
        this.freecamYaw = player.getYaw();
        this.freecamPitch = player.getPitch();
        this.lastMouseX = Client.getMouseX();
        this.lastMouseY = Client.getMouseY();
        this.cameraPos = this.getInitialCameraPos(player, this.freecamYaw, this.freecamPitch);
        this.velocity = new Vec3d(0, 0, 0);
        this.savedPerspective = mc.options.getPerspective();
        if (!MacroState.isMacroRunning()) {
            Keybind.unpressKeys();
        }
        Mixin.set('freecamEnabled', true);
        Mixin.set('freecamFrozenYaw', true);
        Mixin.set('freecamFrozenPitch', true);
        Mixin.set('cameraOverrideYaw', this.freecamYaw);
        Mixin.set('cameraOverridePitch', this.freecamPitch);
        mc.options.setPerspective(Perspective.THIRD_PERSON_BACK);
        Camera.setCameraPosition(this.cameraPos);
    }

    onDisable() {
        this.message('&cDisabled');
        this.cameraPos = null;
        this.velocity = new Vec3d(0, 0, 0);
        if (!MacroState.isMacroRunning()) {
            Keybind.unpressKeys();
        }
        Mixin.set('freecamEnabled', false);
        Mixin.delete('freecamFrozenYaw');
        Mixin.delete('freecamFrozenPitch');
        Mixin.delete('cameraOverrideYaw');
        Mixin.delete('cameraOverridePitch');
        Camera.clearCameraPosition();

        if (this.savedPerspective) {
            mc.options.setPerspective(this.savedPerspective);
        }

        this.savedPerspective = null;
    }

    onTick() {
        if (!this.enabled || !World.isLoaded() || Client.isInGui()) {
            this.lastMouseX = Client.getMouseX();
            this.lastMouseY = Client.getMouseY();
            return;
        }

        const player = Player.getPlayer();
        if (!player) return;

        if (!this.cameraPos) {
            this.freecamYaw = player.getYaw();
            this.freecamPitch = player.getPitch();
            this.cameraPos = this.getInitialCameraPos(player, this.freecamYaw, this.freecamPitch);
        }

        // Handle independent rotation via mouse delta
        const currentMouseX = Client.getMouseX();
        const currentMouseY = Client.getMouseY();

        if (this.lastMouseX !== null && this.lastMouseY !== null) {
            const dx = currentMouseX - this.lastMouseX;
            const dy = currentMouseY - this.lastMouseY;

            if (dx !== 0 || dy !== 0) {
                // Get player sensitivity from options
                let sens = mc.options.getMouseSensitivity().getValue();
                if (sens === undefined) sens = 0.5;
                
                const multiplier = (sens * 0.6 + 0.2) ** 3 * 8.0 * 0.15;
                
                this.freecamYaw += dx * multiplier;
                this.freecamPitch += dy * multiplier;
                this.freecamPitch = Math.max(-90, Math.min(90, this.freecamPitch));

                Mixin.set('cameraOverrideYaw', this.freecamYaw);
                Mixin.set('cameraOverridePitch', this.freecamPitch);
            }
        }
        this.lastMouseX = currentMouseX;
        this.lastMouseY = currentMouseY;

        if (mc.options.getPerspective() !== Perspective.THIRD_PERSON_BACK) {
            mc.options.setPerspective(Perspective.THIRD_PERSON_BACK);
        }

        const options = mc.options;
        const yawRad = (this.freecamYaw * Math.PI) / 180;
        const pitchRad = (this.freecamPitch * Math.PI) / 180;

        let moveX = 0;
        let moveY = 0;
        let moveZ = 0;

        // Use physical key states to avoid macro interference
        const isDown = (keyBind) => {
            const keyCode = keyBind?.boundKey?.code;
            return keyCode ? Keyboard.isKeyDown(keyCode) : keyBind.isPressed();
        };

        const forwardX = -Math.sin(yawRad) * Math.cos(pitchRad);
        const forwardY = -Math.sin(pitchRad);
        const forwardZ = Math.cos(yawRad) * Math.cos(pitchRad);

        const leftX = Math.cos(yawRad);
        const leftZ = Math.sin(yawRad);

        if (isDown(options.forwardKey)) {
            moveX += forwardX;
            moveY += forwardY;
            moveZ += forwardZ;
        }
        if (isDown(options.backKey)) {
            moveX -= forwardX;
            moveY -= forwardY;
            moveZ -= forwardZ;
        }
        if (isDown(options.leftKey)) {
            moveX += leftX;
            moveZ += leftZ;
        }
        if (isDown(options.rightKey)) {
            moveX -= leftX;
            moveZ -= leftZ;
        }
        if (isDown(options.jumpKey)) {
            moveY += 1;
        }
        if (isDown(options.sneakKey)) {
            moveY -= 1;
        }

        const magnitude = Math.hypot(moveX, moveY, moveZ) || 1;
        const hasInput = Math.abs(moveX) > 0 || Math.abs(moveY) > 0 || Math.abs(moveZ) > 0;

        const targetSpeed = this.moveSpeed;
        const targetX = hasInput ? (moveX / magnitude) * targetSpeed : 0;
        const targetY = hasInput ? (moveY / magnitude) * targetSpeed : 0;
        const targetZ = hasInput ? (moveZ / magnitude) * targetSpeed : 0;

        const smoothing = hasInput ? 0.35 : 0.12;

        this.velocity = new Vec3d(
            this.velocity.x + (targetX - this.velocity.x) * smoothing,
            this.velocity.y + (targetY - this.velocity.y) * smoothing,
            this.velocity.z + (targetZ - this.velocity.z) * smoothing
        );

        const velocityMagnitude = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);
        if (velocityMagnitude < 0.0005) {
            this.velocity = new Vec3d(0, 0, 0);
            Camera.setCameraPosition(this.cameraPos);
            return;
        }

        this.cameraPos = new Vec3d(this.cameraPos.x + this.velocity.x, this.cameraPos.y + this.velocity.y, this.cameraPos.z + this.velocity.z);

        Camera.setCameraPosition(this.cameraPos);
    }

    getInitialCameraPos(player, yaw, pitch) {
        const eyePos = player.getEyePos();
        const yawRad = (yaw * Math.PI) / 180;
        const pitchRad = (pitch * Math.PI) / 180;
        const cosPitch = Math.cos(pitchRad);
        const lookX = -Math.sin(yawRad) * cosPitch;
        const lookY = -Math.sin(pitchRad);
        const lookZ = Math.cos(yawRad) * cosPitch;

        return new Vec3d(eyePos.x - lookX * THIRD_PERSON_DISTANCE, eyePos.y - lookY * THIRD_PERSON_DISTANCE, eyePos.z - lookZ * THIRD_PERSON_DISTANCE);
    }
}

new Freecam();
