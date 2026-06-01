package com.v5.mixins;

import com.v5.storage.V5MixinStorage;
import net.minecraft.client.render.Camera;
import net.minecraft.entity.Entity;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Camera.class)
public abstract class CameraMixin {
    @Shadow
    protected abstract void setPos(Vec3d pos);

    @Shadow
    protected abstract void setRotation(float yaw, float pitch);

    @Inject(method = "update", at = @At("TAIL"))
    private void v5$applyCameraOverride(
            BlockView area,
            Entity focusedEntity,
            boolean thirdPerson,
            boolean inverseView,
            float tickProgress,
            CallbackInfo ci) {
        Object override = V5MixinStorage.get("cameraOverridePos", null);
        if (override instanceof Vec3d pos) {
            this.setPos(pos);
        }

        Object overrideYaw = V5MixinStorage.get("cameraOverrideYaw", null);
        Object overridePitch = V5MixinStorage.get("cameraOverridePitch", null);

        if (overrideYaw instanceof Number && overridePitch instanceof Number) {
            this.setRotation(((Number) overrideYaw).floatValue(), ((Number) overridePitch).floatValue());
        }
    }
}
