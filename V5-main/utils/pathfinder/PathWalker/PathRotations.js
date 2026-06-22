import { BP, Vec3d } from '../../Constants';
import { raytraceBlocks } from '../../dependencies/BloomCore/RaytraceBlocks';
import { Vector3 } from '../../dependencies/BloomCore/Vector3';
import { MathUtils } from '../../Math';
import { PathExecutor } from '../PathExecutor';
import { Spline } from '../PathSpline';
import { predictXZ } from './PathPrediction';
import { PathRotationsUtility } from './PathRotationsUtility';

class PathRotations {
    constructor() {
        this.MIN_LOOKAHEAD = 1.1;
        this.MAX_LOOKAHEAD = 3.5;
        this.RECOVERY_MIN_LOOKAHEAD = 0.05;
        this.PROXIMITY_THRESHOLD = 4.0;
        this.COMPLETION_RADIUS = 1.9;
        this.BASE_KP = 0.05;
        this.KD = 0.55;
        this.MAX_VELOCITY = 8.0;
        this.ACCEL_LIMIT = 1.2;
        this.SETTLE_THRESHOLD = 0.15;
        this.PITCH_DEADZONE = 1.8;
        this.YAW_DEADZONE = 1.2;
        this.SMOOTH_FACTOR = 0.1;
        this.MAX_LOOK_DISTANCE = 0.8;
        this.LOOKAHEAD_STEP = 0.4;
        this.RECOVERY_LOOKAHEAD_STEP = 0.1;
        this.MAX_DIRECTION_DIVERGENCE = 50.0;
        this.MAX_UPWARD_PITCH = -45.0;
        this.PREDICTION_TICKS = 10;
        this.PREDICTION_MIN_SPEED_XZ = 0.05;
        this.PREDICTION_MAX_ADVANCE_GROUND = 0.9;
        this.PREDICTION_MAX_ADVANCE_AIR = 2.4;
        this.TELEPORT_RESYNC_DURATION_TICKS = 14;
        this.TELEPORT_RESYNC_SEARCH_WINDOW = 72;
        this.REACTION_DELAY_MIN_MS = 70;
        this.REACTION_DELAY_MAX_MS = 165;
        this.REACTION_TURN_THRESHOLD = 7.0;
        this.REACTION_COOLDOWN_MS = 360;
        this.OVERSHOOT_TURN_THRESHOLD = 11.0;
        this.OVERSHOOT_MAX_YAW = 4.25;
        this.OVERSHOOT_MAX_PITCH = 2.1;
        this.OVERSHOOT_DURATION_MIN_MS = 230;
        this.OVERSHOOT_DURATION_MAX_MS = 420;
        this.NOISE_YAW_STDDEV = 0.12;
        this.NOISE_PITCH_STDDEV = 0.075;
        this.NOISE_SMOOTHING = 0.86;
        this.NOISE_FADE_ERROR = 2.4;
        this.ROTATION_LEAD_MIN = 0.45;
        this.ROTATION_LEAD_MAX = 3.2;
        this.lookaheadOverride = null;
        this.lookaheadOverrideExpiry = 0;
        this.currentPathCurvature = 0;
        this.failed = false;
        this.rollbackAttempts = 0;
        this.maxRollbackAttempts = 12;

        this.resetRotations();

        PathExecutor.onStep(() => {
            if (!this.rotationActive || !this.boxPositions || this.boxPositions.length < 2) return;
            if (!Player.getPlayer()) {
                this.resetRotations();
                return;
            }
            this.updateLookPoint();
            if (this.failed || !this.rotationActive) return;
            this.applyHumanizedPhysics();
            const output = this.getOutputRotation();
            PathRotationsUtility.applyRotationWithGCD(output.yaw, output.pitch);
        });

        PathExecutor.onTick(() => {
            if (this.postTeleportResyncTicks > 0) {
                this.postTeleportResyncTicks--;
            }

            if (this.lookaheadOverrideExpiry > 0) {
                this.lookaheadOverrideExpiry--;
                if (this.lookaheadOverrideExpiry <= 0) {
                    this.lookaheadOverride = null;
                }
            }
        });
    }

    resetRotations() {
        this.currentPathPosition = 0.0;
        this.isInitialized = false;
        this.complete = false;
        this.rotationActive = false;
        this.yawVelocity = 0;
        this.pitchVelocity = 0;
        this.rawTargetYaw = 0;
        this.rawTargetPitch = 0;
        this.currentYaw = 0;
        this.currentPitch = 0;
        this.boxPositions = null;
        this.currentTargetPoint = null;
        this.smoothedLookahead = this.MAX_LOOKAHEAD;
        this.lookaheadOverride = null;
        this.lookaheadOverrideExpiry = 0;
        this.unseenSince = 0;
        this.unseenStartPathPosition = 0;
        this.currentPathCurvature = 0;
        this.initialTurnBoostTicks = 0;
        this.postTeleportResyncTicks = 0;
        this.pendingReactionTarget = null;
        this.reactionDelayUntil = 0;
        this.lastReactionAt = 0;
        this.bezierTurn = null;
        this.overshoot = null;
        this.noiseYaw = 0;
        this.noisePitch = 0;
        this.lastRotationError = 0;
        this.failed = false;
        this.rollbackAttempts = 0;
        PathRotationsUtility.stopRotation();
    }

    isValidPoint(point) {
        return (
            !!point &&
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            Number.isFinite(point.z)
        );
    }

    hasValidPathPoints(points) {
        return Array.isArray(points) && points.length >= 2 && points.every((point) => this.isValidPoint(point));
    }

    failRotations() {
        this.failed = true;
        this.rotationActive = false;
    }

    onTeleportTriggered(targetPathPosition = null) {
        this.postTeleportResyncTicks = this.TELEPORT_RESYNC_DURATION_TICKS;
        this.unseenSince = 0;
        this.unseenStartPathPosition = this.currentPathPosition;
        this.setTemporaryLookahead(this.MAX_LOOKAHEAD, this.TELEPORT_RESYNC_DURATION_TICKS);

        if (typeof targetPathPosition === 'number') {
            this.currentPathPosition = Math.max(this.currentPathPosition, Math.max(0, targetPathPosition - 2.0));
        }
    }

    shouldBoostInitialTurn(yawError) {
        return this.initialTurnBoostTicks > 0 && Math.abs(yawError) >= Math.max(35.0, this.YAW_DEADZONE * 4);
    }

    getInitialTurnBoostFactor(yawError) {
        return this.shouldBoostInitialTurn(yawError) ? 2.0 : 1.0;
    }

    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    randomBetween(min, max) {
        return min + Math.random() * (max - min);
    }

    gaussianRandom() {
        let u = 0;
        let v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    bezierEase(progress) {
        const t = this.clamp(progress, 0, 1);
        const inv = 1 - t;
        const p1 = 0.18;
        const p2 = 0.82;
        return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
    }

    getTurnDistance(fromYaw, fromPitch, toYaw, toPitch) {
        return Math.hypot(MathUtils.getAngleDifference(fromYaw, toYaw), toPitch - fromPitch);
    }

    shouldDelayTurn(turnDistance, finishFactor, now) {
        if (turnDistance < this.REACTION_TURN_THRESHOLD) return false;
        if (finishFactor < 0.35) return false;
        if (this.isInRecoveryMode() || this.postTeleportResyncTicks > 0) return false;
        if (now - this.lastReactionAt < this.REACTION_COOLDOWN_MS) return false;
        return this.initialTurnBoostTicks > 0 || this.currentPathCurvature > 0.18 || turnDistance >= this.REACTION_TURN_THRESHOLD * 1.7;
    }

    beginBezierTurn(targetYaw, targetPitch, now, initialDistance = null) {
        const distance = Number.isFinite(initialDistance) ? initialDistance : this.getTurnDistance(this.currentYaw, this.currentPitch, targetYaw, targetPitch);
        if (distance < this.REACTION_TURN_THRESHOLD * 0.7) return;

        this.bezierTurn = {
            targetYaw,
            targetPitch,
            startedAt: now,
            durationMs: this.clamp(120 + distance * 9, 150, 520),
            initialDistance: distance,
        };
    }

    getBezierTurnScale(targetYaw, targetPitch, now) {
        if (!this.bezierTurn) return 1.0;

        const targetShift = this.getTurnDistance(this.bezierTurn.targetYaw, this.bezierTurn.targetPitch, targetYaw, targetPitch);
        if (targetShift > Math.max(4.0, this.bezierTurn.initialDistance * 0.25)) {
            this.beginBezierTurn(targetYaw, targetPitch, now);
        }

        if (!this.bezierTurn) return 1.0;

        const progress = (now - this.bezierTurn.startedAt) / this.bezierTurn.durationMs;
        if (progress >= 1) {
            this.bezierTurn = null;
            return 1.0;
        }

        return 0.22 + this.bezierEase(progress) * 1.03;
    }

    beginOvershoot(targetYaw, targetPitch, turnDistance, now) {
        if (turnDistance < this.OVERSHOOT_TURN_THRESHOLD || this.isInRecoveryMode() || this.postTeleportResyncTicks > 0) return;

        const yawDelta = MathUtils.getAngleDifference(this.currentYaw, targetYaw);
        const pitchDelta = targetPitch - this.currentPitch;
        const absYawDelta = Math.abs(yawDelta);
        const absPitchDelta = Math.abs(pitchDelta);
        const yawDirection = Math.sign(yawDelta) || 1;
        const pitchDirection = Math.sign(pitchDelta) || 0;
        const strength = this.randomBetween(0.75, 1.25);

        this.overshoot = {
            yaw: absYawDelta > 0.5 ? yawDirection * Math.min(this.OVERSHOOT_MAX_YAW, Math.max(0.35, absYawDelta * 0.09)) * strength : 0,
            pitch: absPitchDelta > 0.35 ? pitchDirection * Math.min(this.OVERSHOOT_MAX_PITCH, Math.max(0.18, absPitchDelta * 0.08)) * strength : 0,
            startedAt: now,
            durationMs: this.randomBetween(this.OVERSHOOT_DURATION_MIN_MS, this.OVERSHOOT_DURATION_MAX_MS),
        };
    }

    getOvershootOffset(now) {
        if (!this.overshoot) return { yaw: 0, pitch: 0 };

        const progress = (now - this.overshoot.startedAt) / this.overshoot.durationMs;
        if (progress >= 1) {
            this.overshoot = null;
            return { yaw: 0, pitch: 0 };
        }

        const envelope = Math.sin(Math.PI * this.clamp(progress, 0, 1));
        return {
            yaw: this.overshoot.yaw * envelope,
            pitch: this.overshoot.pitch * envelope,
        };
    }

    updateHumanizedTarget(targetYaw, targetPitch, smooth, yawDeadzone, pitchDeadzone, finishFactor) {
        const now = Date.now();

        if (this.reactionDelayUntil > now) {
            this.pendingReactionTarget = { yaw: targetYaw, pitch: targetPitch };
            return;
        }

        if (this.pendingReactionTarget) {
            targetYaw = this.pendingReactionTarget.yaw;
            targetPitch = this.pendingReactionTarget.pitch;
            this.pendingReactionTarget = null;
        }

        const yawDelta = MathUtils.getAngleDifference(this.rawTargetYaw, targetYaw);
        const pitchDelta = targetPitch - this.rawTargetPitch;
        const turnDistance = Math.hypot(yawDelta, pitchDelta);

        if (this.shouldDelayTurn(turnDistance, finishFactor, now)) {
            this.reactionDelayUntil = now + this.randomBetween(this.REACTION_DELAY_MIN_MS, this.REACTION_DELAY_MAX_MS);
            this.pendingReactionTarget = { yaw: targetYaw, pitch: targetPitch };
            this.lastReactionAt = now;
            return;
        }

        if (turnDistance >= this.REACTION_TURN_THRESHOLD && !this.bezierTurn) {
            this.beginBezierTurn(targetYaw, targetPitch, now, turnDistance);
        }

        const easedSmooth = Math.min(1.0, smooth * this.getBezierTurnScale(targetYaw, targetPitch, now));

        if (Math.abs(yawDelta) > yawDeadzone) {
            this.rawTargetYaw = MathUtils.wrapTo180(this.rawTargetYaw + yawDelta * easedSmooth);
        }

        if (Math.abs(pitchDelta) > pitchDeadzone) {
            this.rawTargetPitch += pitchDelta * easedSmooth;
        }

        if (turnDistance >= this.OVERSHOOT_TURN_THRESHOLD && !this.overshoot) {
            this.beginOvershoot(targetYaw, targetPitch, turnDistance, now);
        }
    }

    getLookaheadRotationTarget(playerEyes, targetPoint, currentLookahead) {
        if (!this.isValidPoint(playerEyes) || !this.isValidPoint(targetPoint)) return targetPoint;
        if (this.isInRecoveryMode() || this.postTeleportResyncTicks > 0) return targetPoint;
        if (!Number.isFinite(currentLookahead)) return targetPoint;

        const speedXZ = Math.hypot(Player.getMotionX(), Player.getMotionZ());
        const curvatureFactor = this.clamp(this.currentPathCurvature / 1.2, 0, 1);
        const lead = this.clamp(0.85 + speedXZ * 7.0 - curvatureFactor * 0.8, this.ROTATION_LEAD_MIN, this.ROTATION_LEAD_MAX);
        const futureT = Math.min(this.boxPositions.length - 1, this.currentPathPosition + currentLookahead + lead);
        const futurePoint = this.getInterpolatedPoint(futureT);
        if (!this.isValidPoint(futurePoint)) return targetPoint;
        if (!this.isPointVisible(playerEyes, futurePoint)) return targetPoint;

        const toCurrent = {
            x: targetPoint.x - playerEyes.x,
            y: targetPoint.y - playerEyes.y,
            z: targetPoint.z - playerEyes.z,
        };
        const toFuture = {
            x: futurePoint.x - playerEyes.x,
            y: futurePoint.y - playerEyes.y,
            z: futurePoint.z - playerEyes.z,
        };
        if (this.getAngleBetweenVectors(toCurrent, toFuture) > this.MAX_DIRECTION_DIVERGENCE * 0.85) return targetPoint;

        const blend = this.currentPathCurvature < 0.2 ? 0.42 : 0.24;
        return new Vec3d(
            targetPoint.x + (futurePoint.x - targetPoint.x) * blend,
            targetPoint.y + (futurePoint.y - targetPoint.y) * blend,
            targetPoint.z + (futurePoint.z - targetPoint.z) * blend
        );
    }

    getOutputRotation() {
        const fade = this.isInRecoveryMode() || this.complete ? 0 : this.clamp(this.lastRotationError / this.NOISE_FADE_ERROR, 0, 1);
        const keep = this.NOISE_SMOOTHING;
        const drive = Math.sqrt(1 - keep * keep);
        this.noiseYaw = this.noiseYaw * keep + this.gaussianRandom() * this.NOISE_YAW_STDDEV * drive;
        this.noisePitch = this.noisePitch * keep + this.gaussianRandom() * this.NOISE_PITCH_STDDEV * drive;

        return {
            yaw: MathUtils.wrapTo180(this.currentYaw + this.noiseYaw * fade),
            pitch: this.clamp(this.currentPitch + this.noisePitch * fade, -90, 90),
        };
    }

    isPointVisible(playerEyes, targetPoint) {
        if (!this.isValidPoint(playerEyes) || !this.isValidPoint(targetPoint)) return false;

        const dx = targetPoint.x - playerEyes.x;
        const dy = targetPoint.y - playerEyes.y;
        const dz = targetPoint.z - playerEyes.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 0.2) return true;
        try {
            const dir = new Vector3(dx / dist, dy / dist, dz / dist);
            const hit = raytraceBlocks(
                [playerEyes.x, playerEyes.y, playerEyes.z],
                dir,
                dist + 0.1,
                (block) => {
                    if (!block || !block.type || block.type.getID() === 0) return false;
                    try {
                        const world = World.getWorld();
                        const pos = new BP(Math.floor(block.getX()), Math.floor(block.getY()), Math.floor(block.getZ()));
                        const state = world.getBlockState(pos);
                        return !state.getCollisionShape(world, pos).isEmpty();
                    } catch (e) {
                        return true;
                    }
                },
                true
            );
            if (!hit) return true;
            const hitX = hit[0] + 0.5;
            const hitY = hit[1] + 0.5;
            const hitZ = hit[2] + 0.5;
            const hdx = hitX - playerEyes.x;
            const hdy = hitY - playerEyes.y;
            const hdz = hitZ - playerEyes.z;
            const hitDist = Math.sqrt(hdx * hdx + hdy * hdy + hdz * hdz);
            return hitDist >= dist - 0.5;
        } catch (e) {
            return true;
        }
    }

    getAngleBetweenVectors(v1, v2) {
        if (!this.isValidPoint(v1) || !this.isValidPoint(v2)) return 0;

        const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y + v1.z * v1.z);
        const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y + v2.z * v2.z);
        if (mag1 < 0.001 || mag2 < 0.001) return 0;
        const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
        const val = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
        return Math.acos(val) * (180 / Math.PI);
    }

    setTemporaryLookahead(distance, durationTicks = 30) {
        this.lookaheadOverride = distance;
        this.lookaheadOverrideExpiry = durationTicks;
        this.smoothedLookahead = distance;
    }

    isInRecoveryMode() {
        return this.lookaheadOverride !== null && this.lookaheadOverrideExpiry > 0;
    }

    findVisibleLookahead(playerEyes, idealLookahead) {
        if (!this.isValidPoint(playerEyes)) return null;
        const immediateT = Math.min(this.boxPositions.length - 1, this.currentPathPosition + 0.5);
        const immediatePoint = this.getInterpolatedPoint(immediateT);
        if (!this.isValidPoint(immediatePoint)) return null;

        const vecImmediate = {
            x: immediatePoint.x - playerEyes.x,
            y: immediatePoint.y - playerEyes.y,
            z: immediatePoint.z - playerEyes.z,
        };
        const inRecovery = this.isInRecoveryMode();
        const effectiveMin = inRecovery ? this.RECOVERY_MIN_LOOKAHEAD : this.MIN_LOOKAHEAD;
        let lookahead = inRecovery ? idealLookahead : Math.max(idealLookahead, this.MIN_LOOKAHEAD);
        while (lookahead >= effectiveMin) {
            const t = Math.min(this.boxPositions.length - 1, this.currentPathPosition + lookahead);
            const point = this.getInterpolatedPoint(t);
            if (!this.isValidPoint(point)) {
                lookahead -= this.LOOKAHEAD_STEP;
                continue;
            }
            const dx = point.x - playerEyes.x;
            const dy = point.y - playerEyes.y;
            const dz = point.z - playerEyes.z;
            const horzDist = Math.hypot(dx, dz);
            if (lookahead >= this.MIN_LOOKAHEAD) {
                if (dy > 1.8 && horzDist < 0.8) {
                    lookahead -= this.LOOKAHEAD_STEP;
                    continue;
                }
                const pitch = -Math.atan2(dy, horzDist) * (180 / Math.PI);
                if (pitch < this.MAX_UPWARD_PITCH && horzDist < 1.5) {
                    lookahead -= this.LOOKAHEAD_STEP;
                    continue;
                }
                const vecTarget = { x: dx, y: dy, z: dz };
                const divergence = this.getAngleBetweenVectors(vecImmediate, vecTarget);
                if (divergence > this.MAX_DIRECTION_DIVERGENCE) {
                    lookahead -= this.LOOKAHEAD_STEP;
                    continue;
                }
            }
            if (this.isPointVisible(playerEyes, point)) {
                return { point, lookahead };
            }
            const step = lookahead < this.MIN_LOOKAHEAD ? this.RECOVERY_LOOKAHEAD_STEP : this.LOOKAHEAD_STEP;
            lookahead -= step;
        }
        let closeLookahead = Math.max(this.RECOVERY_MIN_LOOKAHEAD, this.MIN_LOOKAHEAD - 0.2);
        while (closeLookahead >= this.RECOVERY_MIN_LOOKAHEAD) {
            const t = Math.min(this.boxPositions.length - 1, this.currentPathPosition + closeLookahead);
            const point = this.getInterpolatedPoint(t);
            if (!this.isValidPoint(point)) {
                closeLookahead -= this.RECOVERY_LOOKAHEAD_STEP;
                continue;
            }
            if (this.isPointVisible(playerEyes, point)) {
                return { point, lookahead: closeLookahead };
            }
            closeLookahead -= this.RECOVERY_LOOKAHEAD_STEP;
        }
        const t = Math.min(this.boxPositions.length - 1, this.currentPathPosition + effectiveMin);
        const point = this.getInterpolatedPoint(t);
        return this.isValidPoint(point) ? { point, lookahead: effectiveMin } : null;
    }

    getAdaptiveLookahead(playerEyes) {
        if (!this.isValidPoint(playerEyes)) return this.smoothedLookahead;
        if (this.lookaheadOverride !== null && this.lookaheadOverrideExpiry > 0) return this.lookaheadOverride;
        const targetIndex = Math.floor(this.currentPathPosition);
        if (targetIndex + 3 >= this.boxPositions.length) return this.smoothedLookahead;
        const pathPoint = this.getInterpolatedPoint(this.currentPathPosition);
        if (!this.isValidPoint(pathPoint)) return this.smoothedLookahead;

        const pdx = playerEyes.x - pathPoint.x;
        const pdz = playerEyes.z - pathPoint.z;
        const deviationFromPath = Math.sqrt(pdx * pdx + pdz * pdz);
        const deviationFactor = Math.min(1, Math.max(0, (deviationFromPath - 1.6) / 2.0));
        const startIndex = this.boxPositions[targetIndex];
        const endIndex = this.boxPositions[Math.min(targetIndex + 2, this.boxPositions.length - 1)];
        if (!this.isValidPoint(startIndex) || !this.isValidPoint(endIndex)) return this.smoothedLookahead;

        const currDx = endIndex.x - startIndex.x;
        const currDy = endIndex.y - startIndex.y;
        const currDz = endIndex.z - startIndex.z;
        const startDirection = { x: currDx, y: currDy, z: currDz };
        const startDirectionMagnitude = Math.hypot(currDx, currDy, currDz);
        let maxAngle = 0;
        for (let lookahead = 4; lookahead <= 8; lookahead += 2) {
            const futureTargetIndex = Math.min(targetIndex + lookahead, this.boxPositions.length - 3);
            if (futureTargetIndex <= targetIndex + 2) continue;
            const futureA = this.boxPositions[futureTargetIndex];
            const futureB = this.boxPositions[Math.min(futureTargetIndex + 2, this.boxPositions.length - 1)];
            if (!this.isValidPoint(futureA) || !this.isValidPoint(futureB)) continue;

            const futureDx = futureB.x - futureA.x;
            const futureDy = futureB.y - futureA.y;
            const futureDz = futureB.z - futureA.z;
            const futureDirection = { x: futureDx, y: futureDy, z: futureDz };
            const futureDirectionMagnitude = Math.hypot(futureDx, futureDy, futureDz);
            if (startDirectionMagnitude > 0.8 && futureDirectionMagnitude > 0.8) {
                const dotProduct =
                    (startDirection.x * futureDirection.x + startDirection.y * futureDirection.y + startDirection.z * futureDirection.z) /
                    (startDirectionMagnitude * futureDirectionMagnitude);
                const angle = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
                maxAngle = Math.max(maxAngle, angle);
            }
        }
        this.currentPathCurvature = maxAngle;
        const isFalling = Player.getMotionY() < -0.1;
        const isInRecovery = this.isInRecoveryMode();
        if (isFalling) maxAngle *= 0.5;
        
        let curveFactor = Math.min(1, Math.max(0, (maxAngle - 0.61) / 0.7));
        if (isInRecovery) curveFactor = Math.min(1, curveFactor * 1.3);
        
        const adjustFactor = Math.max(deviationFactor, curveFactor);
        const targetLookaheadDistance = this.MAX_LOOKAHEAD - (this.MAX_LOOKAHEAD - this.MIN_LOOKAHEAD) * adjustFactor;
        let lerpFactor = targetLookaheadDistance > this.smoothedLookahead ? 0.1 : 0.05;
        if (isInRecovery) lerpFactor *= 1.5;
        this.smoothedLookahead += (targetLookaheadDistance - this.smoothedLookahead) * lerpFactor;
        return this.smoothedLookahead;
    }

    isPathDropping() {
        if (!this.boxPositions || this.currentPathPosition >= this.boxPositions.length - 2) return false;
        const current = this.getInterpolatedPoint(this.currentPathPosition);
        const lookAhead = this.getInterpolatedPoint(Math.min(this.boxPositions.length - 1, this.currentPathPosition + 2));
        if (!this.isValidPoint(current) || !this.isValidPoint(lookAhead)) return false;

        return current.y - lookAhead.y > 0.8;
    }

    updateLookPoint() {
        const player = Player.getPlayer();
        if (!player) return;
        const playerEyes = player.getEyePos();
        if (!this.isValidPoint(playerEyes)) {
            this.failRotations();
            return;
        }

        const motionY = Player.getMotionY();
        const isFalling = motionY < -0.4 || this.isPathDropping();
        const pathAnchor = this.getInterpolatedPoint(this.currentPathPosition);
        if (!this.isValidPoint(pathAnchor)) {
            this.failRotations();
            return;
        }
        const isJumpingHigh = motionY > 0.1 || player.getY() - pathAnchor.y > 2.0;

        let bestT = this.currentPathPosition;
        let minDistanceSq = Infinity;

        const isTeleportResync = this.postTeleportResyncTicks > 0;
        let searchWindow = isFalling ? 4 : isJumpingHigh ? 12 : 8;
        let startIdx = isFalling ? Math.floor(this.currentPathPosition) : Math.max(0, Math.floor(this.currentPathPosition) - 2);
        if (isTeleportResync) {
            searchWindow = Math.max(searchWindow, this.TELEPORT_RESYNC_SEARCH_WINDOW);
            startIdx = Math.max(0, Math.floor(this.currentPathPosition) - 24);
        }

        const endIdx = Math.min(this.boxPositions.length - 2, startIdx + searchWindow);

        for (let i = startIdx; i <= endIdx; i++) {
            const p1 = this.boxPositions[i];
            const p2 = this.boxPositions[i + 1];
            if (!this.isValidPoint(p1) || !this.isValidPoint(p2)) continue;

            const segmentProgress =
                isFalling || isJumpingHigh ? this.getClosestPointOnSegmentHorizontal(playerEyes, p1, p2) : this.getClosestPointOnSegment(playerEyes, p1, p2);

            const candidateT = i + segmentProgress;

            if (isFalling && candidateT < this.currentPathPosition) continue;

            const projectedPoint = this.getInterpolatedPoint(candidateT);
            if (!this.isValidPoint(projectedPoint)) continue;

            let distSq = isFalling
                ? Math.pow(playerEyes.x - projectedPoint.x, 2) + Math.pow(playerEyes.z - projectedPoint.z, 2)
                : this.getDistSq(playerEyes, projectedPoint);

            if (distSq < minDistanceSq) {
                minDistanceSq = distSq;
                bestT = candidateT;
            }
        }

        let effectiveThreshold = isFalling ? 5.0 : isJumpingHigh ? this.PROXIMITY_THRESHOLD * 2 : this.PROXIMITY_THRESHOLD;
        if (isTeleportResync) effectiveThreshold *= 1.8;
        if (minDistanceSq < effectiveThreshold * effectiveThreshold) {
            const maxJump = isTeleportResync ? 14.0 : isFalling ? 0.5 : 2.0;
            const nextPosition = Math.min(this.currentPathPosition + maxJump, bestT);
            this.currentPathPosition = isTeleportResync
                ? nextPosition
                : Math.max(this.currentPathPosition, nextPosition);
        }
        if (!isTeleportResync) {
            this.applyPredictedPathProgress(player);
        }

        const adaptiveLookahead = this.getAdaptiveLookahead(playerEyes);
        let result = this.findVisibleLookahead(playerEyes, adaptiveLookahead);
        if (!result || !this.isValidPoint(result.point)) {
            this.failRotations();
            return;
        }

        const effectiveMin = this.isInRecoveryMode() ? this.RECOVERY_MIN_LOOKAHEAD : this.MIN_LOOKAHEAD;
        let targetVisible = this.isPointVisible(playerEyes, result.point);
        const now = Date.now();

        if (result.lookahead <= effectiveMin + 0.001 && !targetVisible) {
            if (!this.unseenSince) {
                this.unseenSince = now;
                this.unseenStartPathPosition = this.currentPathPosition;
            }
            if (now - this.unseenSince >= 600) {
                this.rollbackAttempts = 0;
                const minRollbackPosition = Math.max(0, this.unseenStartPathPosition - 10);
                while (this.currentPathPosition > minRollbackPosition && this.rollbackAttempts < this.maxRollbackAttempts) {
                    this.currentPathPosition = Math.max(minRollbackPosition, this.currentPathPosition - 1);
                    const t = Math.min(this.boxPositions.length - 1, this.currentPathPosition + effectiveMin);
                    const rollbackPoint = this.getInterpolatedPoint(t);
                    if (this.isValidPoint(rollbackPoint) && this.isPointVisible(playerEyes, rollbackPoint)) {
                        this.unseenSince = 0;
                        this.unseenStartPathPosition = this.currentPathPosition;
                        result = this.findVisibleLookahead(playerEyes, adaptiveLookahead);
                        if (!result || !this.isValidPoint(result.point)) {
                            this.failRotations();
                            return;
                        }
                        targetVisible = this.isPointVisible(playerEyes, result.point);
                        break;
                    }
                    this.rollbackAttempts++;
                }
                if (!targetVisible) {
                    this.failRotations();
                    return;
                }
            }
        } else {
            this.unseenSince = 0;
            this.unseenStartPathPosition = this.currentPathPosition;
            this.rollbackAttempts = 0;
        }

        let targetPoint = result.point;
        if (result.lookahead < this.smoothedLookahead) this.smoothedLookahead = this.smoothedLookahead * 0.9 + result.lookahead * 0.1;

        const rawDx = targetPoint.x - playerEyes.x;
        const rawDy = targetPoint.y - playerEyes.y;
        const rawDz = targetPoint.z - playerEyes.z;
        const rawHorz = Math.hypot(rawDx, rawDz);
        const rawPitch = -Math.atan2(rawDy, rawHorz) * (180 / Math.PI);

        if (rawPitch < -50 && rawHorz < 1.0) {
            const newDy = rawHorz * Math.tan(30 * (Math.PI / 180));
            targetPoint = new Vec3d(targetPoint.x, playerEyes.y + newDy, targetPoint.z);
        }

        if (isFalling && rawHorz < 0.5) {
            const boostT = Math.min(this.boxPositions.length - 1, this.currentPathPosition + 2.5);
            const boostedPoint = this.getInterpolatedPoint(boostT);
            if (!this.isValidPoint(boostedPoint)) {
                this.failRotations();
                return;
            }
            targetPoint = boostedPoint;
        }

        targetPoint = this.getLookaheadRotationTarget(playerEyes, targetPoint, result.lookahead);

        const dx = targetPoint.x - playerEyes.x;
        const dy = targetPoint.y - playerEyes.y;
        const dz = targetPoint.z - playerEyes.z;
        const dist = Math.hypot(dx, dy, dz);

        if (dist > this.MAX_LOOK_DISTANCE) {
            const scale = this.MAX_LOOK_DISTANCE / dist;
            targetPoint = new Vec3d(playerEyes.x + dx * scale, playerEyes.y + dy * scale, playerEyes.z + dz * scale);
        }

        this.currentTargetPoint = targetPoint;
        const angles = MathUtils.calculateAbsoluteAngles(this.currentTargetPoint);
        const targetYaw = MathUtils.wrapTo180(angles.yaw);

        const lastIndex = this.boxPositions.length - 1;
        const remainingPath = lastIndex - this.currentPathPosition;
        const finishFactor = remainingPath < 3.0 ? Math.max(0.1, remainingPath / 3.0) : 1.0;
        const isStraight = this.currentPathCurvature < 0.15;
        const dynamicSmoothBase = (isStraight ? this.SMOOTH_FACTOR * 0.5 : this.SMOOTH_FACTOR) / finishFactor;
        const targetYawDelta = MathUtils.getAngleDifference(this.rawTargetYaw, targetYaw);
        const dynamicSmooth = Math.min(1.0, dynamicSmoothBase * this.getInitialTurnBoostFactor(targetYawDelta));
        const dynamicYawDeadzone = (isStraight ? this.YAW_DEADZONE * 1.5 : this.YAW_DEADZONE) * finishFactor;

        this.updateHumanizedTarget(targetYaw, angles.pitch, dynamicSmooth, dynamicYawDeadzone, this.PITCH_DEADZONE * finishFactor, finishFactor);

        if (this.initialTurnBoostTicks > 0 && !this.pendingReactionTarget && this.reactionDelayUntil <= Date.now()) {
            if (Math.abs(MathUtils.getAngleDifference(this.currentYaw, this.rawTargetYaw)) <= Math.max(10.0, this.YAW_DEADZONE * 2)) {
                this.initialTurnBoostTicks = 0;
            } else {
                this.initialTurnBoostTicks--;
            }
        }

        const lastPoint = this.boxPositions[lastIndex];
        if (!this.isValidPoint(lastPoint)) {
            this.failRotations();
            return;
        }

        const endDistSq = Math.pow(playerEyes.x - lastPoint.x, 2) + Math.pow(playerEyes.y - lastPoint.y, 2) + Math.pow(playerEyes.z - lastPoint.z, 2);
        const nearEndBy3D = endDistSq <= Math.pow(this.COMPLETION_RADIUS, 2) && this.currentPathPosition >= lastIndex - 2.0;
        const atEndByPosition = this.currentPathPosition >= lastIndex - 0.25;

        if (nearEndBy3D || atEndByPosition) {
            this.currentPathPosition = lastIndex;
            this.complete = true;
            this.rotationActive = false;
        }
    }

    applyHumanizedPhysics() {
        const now = Date.now();
        const overshootOffset = this.getOvershootOffset(now);
        const effectiveTargetYaw = MathUtils.wrapTo180(this.rawTargetYaw + overshootOffset.yaw);
        const effectiveTargetPitch = this.clamp(this.rawTargetPitch + overshootOffset.pitch, -90, 90);
        const stepScale = this.clamp(PathExecutor.getStepDeltaSeconds() * 120, 0.5, 2.5);

        this.currentYaw = MathUtils.wrapTo180(this.currentYaw);
        const yawError = MathUtils.getAngleDifference(this.currentYaw, effectiveTargetYaw);
        const pitchError = effectiveTargetPitch - this.currentPitch;
        const absYawError = Math.abs(yawError);
        const isStraight = this.currentPathCurvature < 0.2;
        const initialTurnBoostFactor = this.getInitialTurnBoostFactor(yawError);
        const errorMultiplier = Math.min(1.5, Math.max(0.6, absYawError / 10));
        const dynamicKp = this.BASE_KP * errorMultiplier * initialTurnBoostFactor;
        const dynamicKd = isStraight ? this.KD * 1.3 : this.KD;
        const accelLimit = this.ACCEL_LIMIT * initialTurnBoostFactor;
        const maxVelocity = this.MAX_VELOCITY * initialTurnBoostFactor;

        if (absYawError < this.SETTLE_THRESHOLD && Math.abs(this.yawVelocity) < 0.02) {
            this.currentYaw = effectiveTargetYaw;
            this.yawVelocity = 0;
        } else {
            let desiredYawAccel = yawError * dynamicKp - this.yawVelocity * dynamicKd;
            desiredYawAccel = Math.max(-accelLimit, Math.min(accelLimit, desiredYawAccel));
            this.yawVelocity += desiredYawAccel * stepScale;
            this.yawVelocity *= Math.pow(0.92, stepScale);
            this.yawVelocity = Math.max(-maxVelocity, Math.min(maxVelocity, this.yawVelocity));
            this.currentYaw += this.yawVelocity * stepScale;
        }

        if (Math.abs(pitchError) < this.SETTLE_THRESHOLD && Math.abs(this.pitchVelocity) < 0.02) {
            this.currentPitch = effectiveTargetPitch;
            this.pitchVelocity = 0;
        } else {
            let desiredPitchAccel = pitchError * dynamicKp - this.pitchVelocity * dynamicKd;
            desiredPitchAccel = Math.max(-accelLimit, Math.min(accelLimit, desiredPitchAccel));
            this.pitchVelocity += desiredPitchAccel * stepScale;
            this.pitchVelocity *= Math.pow(0.92, stepScale);
            this.pitchVelocity = Math.max(-maxVelocity, Math.min(maxVelocity, this.pitchVelocity));
            this.currentPitch += this.pitchVelocity * stepScale;
        }
        this.currentPitch = Math.max(-90, Math.min(90, this.currentPitch));
        this.lastRotationError = Math.hypot(MathUtils.getAngleDifference(this.currentYaw, this.rawTargetYaw), this.rawTargetPitch - this.currentPitch);
    }

    getClosestPointOnSegment(p, p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dz = p2.z - p1.z;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq === 0) return 0;
        return Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.y - p1.y) * dy + (p.z - p1.z) * dz) / dSq));
    }

    getClosestPointOnSegmentHorizontal(p, p1, p2) {
        const dx = p2.x - p1.x,
            dz = p2.z - p1.z;
        const dSq = dx * dx + dz * dz;
        if (dSq === 0) return 0;
        return Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.z - p1.z) * dz) / dSq));
    }

    projectPathPositionHorizontal(x, z, hint = 0) {
        if (!this.boxPositions || this.boxPositions.length < 2) return 0;
        const lastSegment = this.boxPositions.length - 2;
        const base = Math.max(0, Math.min(lastSegment, Math.floor(hint)));
        const start = Math.max(0, base - 8);
        const end = Math.min(lastSegment, base + 28);

        let bestT = Math.max(0, Math.min(this.boxPositions.length - 1, hint));
        let bestDistSq = Infinity;

        for (let i = start; i <= end; i++) {
            const a = this.boxPositions[i];
            const b = this.boxPositions[i + 1];
            if (!this.isValidPoint(a) || !this.isValidPoint(b)) continue;

            const abx = b.x - a.x;
            const abz = b.z - a.z;
            const lenSq = abx * abx + abz * abz;
            const t = lenSq <= 1e-8 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq));
            const px = a.x + abx * t;
            const pz = a.z + abz * t;
            const dx = x - px;
            const dz = z - pz;
            const distSq = dx * dx + dz * dz;

            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestT = i + t;
            }
        }

        return bestT;
    }

    applyPredictedPathProgress(player) {
        if (!this.boxPositions || this.boxPositions.length < 2) return;

        const motionX = Player.getMotionX();
        const motionZ = Player.getMotionZ();
        const speedXZ = Math.hypot(motionX, motionZ);
        const onGround = !!player?.isOnGround?.();

        if (onGround && speedXZ < this.PREDICTION_MIN_SPEED_XZ) return;

        const predicted = onGround ? { x: Player.getX(), z: Player.getZ() } : predictXZ(this.PREDICTION_TICKS);
        const projectedPredicted = this.projectPathPositionHorizontal(predicted.x, predicted.z, this.currentPathPosition);
        if (!Number.isFinite(projectedPredicted) || projectedPredicted <= this.currentPathPosition) return;

        const maxAdvance = onGround ? this.PREDICTION_MAX_ADVANCE_GROUND : this.PREDICTION_MAX_ADVANCE_AIR;
        this.currentPathPosition = Math.min(this.currentPathPosition + maxAdvance, projectedPredicted);
    }

    getInterpolatedPoint(indexFloat) {
        if (!this.boxPositions || this.boxPositions.length === 0) return null;
        const safeIndexFloat = Number.isFinite(indexFloat) ? Math.max(0, Math.min(indexFloat, this.boxPositions.length - 1)) : 0;
        const idx = Math.floor(safeIndexFloat),
            frac = safeIndexFloat - idx;
        const p1 = this.boxPositions[idx],
            p2 = this.boxPositions[Math.min(idx + 1, this.boxPositions.length - 1)];
        if (!this.isValidPoint(p1)) return null;
        if (!this.isValidPoint(p2) || frac <= 0) return p1;
        return new Vec3d(p1.x + (p2.x - p1.x) * frac, p1.y + (p2.y - p1.y) * frac, p1.z + (p2.z - p1.z) * frac);
    }

    getDistSq(pos, box) {
        return (pos.x - box.x) ** 2 + (pos.y - box.y) ** 2 + (pos.z - box.z) ** 2;
    }

    pathRotations(splineData) {
        if (!this.boxPositions || this.boxPositions.length < 2) {
            const lookPoints = Spline.createLookPoints(splineData, 0.25, 4.5);
            if (!this.hasValidPathPoints(lookPoints)) {
                this.boxPositions = null;
                this.failRotations();
                return;
            }
            this.boxPositions = lookPoints;
        } else if (!this.hasValidPathPoints(this.boxPositions)) {
            this.failRotations();
            return;
        }
        const player = Player.getPlayer();
        if (player && !this.isInitialized) {
            this.currentYaw = MathUtils.wrapTo180(player.getYaw());
            this.currentPitch = player.getPitch();
            this.rawTargetYaw = this.currentYaw;
            this.rawTargetPitch = this.currentPitch;
            this.yawVelocity = 0;
            this.pitchVelocity = 0;
            this.currentPathPosition = 0;
            this.isInitialized = true;
            this.rotationActive = true;
            this.initialTurnBoostTicks = 10;
        }
    }
}

export const Rotations = new PathRotations();
