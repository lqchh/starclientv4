package com.v5.mixins;

import com.v5.storage.V5MixinStorage;
import net.minecraft.client.input.Input;
import net.minecraft.client.input.KeyboardInput;
import net.minecraft.util.PlayerInput;
import net.minecraft.util.math.Vec2f;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(KeyboardInput.class)
public abstract class KeyboardInputMixin extends Input {
    @Inject(method = "tick", at = @At("TAIL"))
    private void v5$cancelMovementWhileFreecam(CallbackInfo ci) {
        if (!V5MixinStorage.getBoolean("freecamEnabled", false)) {
            return;
        }

        if (!V5MixinStorage.getBoolean("macroEnabled", false)) {
            this.playerInput = PlayerInput.DEFAULT;
            this.movementVector = Vec2f.ZERO;
            return;
        }

        boolean forward = V5MixinStorage.getBoolean("macroInputForward", false);
        boolean backward = V5MixinStorage.getBoolean("macroInputBack", false);
        boolean left = V5MixinStorage.getBoolean("macroInputLeft", false);
        boolean right = V5MixinStorage.getBoolean("macroInputRight", false);
        boolean jump = V5MixinStorage.getBoolean("macroInputJump", false);
        boolean sneak = V5MixinStorage.getBoolean("macroInputSneak", false);
        boolean sprint = V5MixinStorage.getBoolean("macroInputSprint", false);

        this.playerInput = new PlayerInput(forward, backward, left, right, jump, sneak, sprint);
        this.movementVector = new Vec2f(v5$axis(left, right), v5$axis(forward, backward));
    }

    @Unique
    private float v5$axis(boolean positive, boolean negative) {
        if (positive == negative) return 0.0F;
        return positive ? 1.0F : -1.0F;
    }
}
