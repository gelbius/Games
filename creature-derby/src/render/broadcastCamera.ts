/**
 * A camera that behaves like a sports broadcast operator.
 *
 * This is harder than the genetics and deserves the space. The subject is a
 * randomly assembled animal that may sprint, stagger, cartwheel, or corkscrew
 * along the ground, and a naive "put the camera behind the creature" rig fails
 * on every one of those. The specific failures worth naming, because each one
 * has a countermeasure below:
 *
 *   The creature spins, so the camera spins.  A camera whose angle is tied to
 *   the creature's own facing whips around every time the creature tumbles, and
 *   the footage is unwatchable. Here the camera's angle is tied to the
 *   *direction the creature is travelling*, heavily smoothed, and travel
 *   direction is stable even while the body is barrel-rolling.
 *
 *   Limbs flail, so the frame jitters.  The centre of mass twitches every step.
 *   Everything the camera follows goes through a critically damped spring, which
 *   settles without the overshoot a naive lerp gives and without the lag of
 *   heavy averaging.
 *
 *   The creature spreads out and leaves the frame.  Framing distance is
 *   recomputed each frame from where the parts actually are, not from the
 *   resting pose, and it widens quickly but closes in slowly — the operator's
 *   instinct that it is better to be too wide than to lose the subject.
 *
 *   The horizon tilts.  The camera's up vector is pinned to world up, always.
 *   No roll is ever introduced, under any circumstance.
 *
 *   The camera sinks through the floor.  Its height is clamped, so a creature
 *   lying flat cannot drag the shot underground.
 */

import * as THREE from 'three';

/** How quickly the camera converges on where it wants to be, in seconds. */
const POSITION_SMOOTH = 0.42;
const TARGET_SMOOTH = 0.28;

/** Widening is urgent, closing back in is not. */
const WIDEN_SMOOTH = 0.22;
const TIGHTEN_SMOOTH = 1.3;

/** How long the camera takes to swing round to a new direction of travel. */
const AZIMUTH_SMOOTH = 1.9;

/** Fraction of extra room left around the subject. 1.0 would be a tight crop. */
const FRAMING_MARGIN = 1.55;

/** Height of the camera above the subject, as an angle from horizontal. */
const ELEVATION = THREE.MathUtils.degToRad(24);

/** Where the camera sits relative to the direction of travel. */
const TRAILING_ANGLE = THREE.MathUtils.degToRad(46);

/** The camera never drops below this, so it cannot clip through the ground. */
const MIN_HEIGHT = 0.45;

const MIN_DISTANCE = 1.6;
const MAX_DISTANCE = 26;

/** Below this speed the creature is not really going anywhere; hold the angle. */
const HEADING_DEADZONE = 0.18;

/**
 * Critically damped spring, the standard "smooth damp".
 *
 * Chosen over a plain lerp because a lerp's speed depends on frame rate and it
 * either overshoots or crawls. This converges in a predictable time, never
 * overshoots, and behaves the same at 30fps and 144fps.
 */
function smoothDamp(current: number, target: number, velocity: number, smoothTime: number, dt: number): [number, number] {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  const nextVelocity = (velocity - omega * temp) * exp;
  let output = target + (change + temp) * exp;

  // Never step past the target, which a spring can do on a very long frame.
  if (target - current > 0 === output > target) {
    output = target;
    return [output, (output - target) / dt];
  }
  return [output, nextVelocity];
}

/** Shortest signed angular difference, so the camera never takes the long way round. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** What the camera needs to know about its subject. */
export interface Subject {
  /** Mass-weighted centre. */
  centre: THREE.Vector3;
  /** Distance from that centre to the furthest part, right now. */
  radius: number;
  /** How fast and which way the subject is travelling, in metres per second. */
  velocity: THREE.Vector3;
}

export class BroadcastCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Where the camera is looking, smoothed. */
  private readonly lookAt = new THREE.Vector3();
  private readonly lookVelocity = new THREE.Vector3();

  /** Where the camera is, smoothed. */
  private readonly position = new THREE.Vector3();
  private readonly positionVelocity = new THREE.Vector3();

  private distance = 6;
  private distanceVelocity = 0;

  private azimuth = 0;
  private azimuthVelocity = 0;

  private initialised = false;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    // Pinned once, never touched again. This single line is what keeps the
    // horizon level no matter what the creature does.
    this.camera.up.set(0, 1, 0);
  }

  /** Jump straight to framing this subject, with no easing. Use when cutting. */
  reset(subject: Subject): void {
    this.initialised = false;
    this.update(subject, 1 / 60);
  }

  update(subject: Subject, dt: number): void {
    const step = Math.min(dt, 0.1); // a long frame must not fling the camera

    // ---------------------------------------------------------------- framing
    // How far back the whole subject fits, for this aspect ratio. Using the
    // narrower of the two half-angles means a wide creature stays in frame on a
    // tall window and vice versa.
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const half = Math.min(vHalf, hHalf);
    const wanted = THREE.MathUtils.clamp(
      (Math.max(subject.radius, 0.25) * FRAMING_MARGIN) / Math.sin(half),
      MIN_DISTANCE,
      MAX_DISTANCE,
    );

    if (!this.initialised) {
      this.distance = wanted;
    } else {
      // Pull back fast, come back in slowly.
      const smooth = wanted > this.distance ? WIDEN_SMOOTH : TIGHTEN_SMOOTH;
      [this.distance, this.distanceVelocity] = smoothDamp(this.distance, wanted, this.distanceVelocity, smooth, step);
    }

    // ---------------------------------------------------------------- heading
    // Follow the direction of travel, not the creature's own facing. A creature
    // rolling end over end has a wildly spinning facing and a perfectly steady
    // direction of travel.
    const speed = Math.hypot(subject.velocity.x, subject.velocity.z);
    if (speed > HEADING_DEADZONE) {
      const heading = Math.atan2(subject.velocity.x, subject.velocity.z);
      const wantedAzimuth = heading + Math.PI + TRAILING_ANGLE;
      if (!this.initialised) {
        this.azimuth = wantedAzimuth;
      } else {
        // Smooth along the shortest arc, so crossing due north does not send
        // the camera all the way round the other side.
        const target = this.azimuth + angleDelta(this.azimuth, wantedAzimuth);
        [this.azimuth, this.azimuthVelocity] = smoothDamp(
          this.azimuth,
          target,
          this.azimuthVelocity,
          AZIMUTH_SMOOTH,
          step,
        );
      }
    }

    // --------------------------------------------------------------- position
    const horizontal = Math.cos(ELEVATION) * this.distance;
    const wantedPosition = new THREE.Vector3(
      subject.centre.x + Math.sin(this.azimuth) * horizontal,
      subject.centre.y + Math.sin(ELEVATION) * this.distance,
      subject.centre.z + Math.cos(this.azimuth) * horizontal,
    );
    wantedPosition.y = Math.max(wantedPosition.y, MIN_HEIGHT);

    if (!this.initialised) {
      this.position.copy(wantedPosition);
      this.lookAt.copy(subject.centre);
      this.positionVelocity.set(0, 0, 0);
      this.lookVelocity.set(0, 0, 0);
      this.initialised = true;
    } else {
      smoothVector(this.position, wantedPosition, this.positionVelocity, POSITION_SMOOTH, step);
      smoothVector(this.lookAt, subject.centre, this.lookVelocity, TARGET_SMOOTH, step);
    }

    // Applied after smoothing too: easing toward a legal height could still
    // pass through the floor on the way.
    this.position.y = Math.max(this.position.y, MIN_HEIGHT);

    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.lookAt);
  }
}

function smoothVector(
  current: THREE.Vector3,
  target: THREE.Vector3,
  velocity: THREE.Vector3,
  smoothTime: number,
  dt: number,
): void {
  [current.x, velocity.x] = smoothDamp(current.x, target.x, velocity.x, smoothTime, dt);
  [current.y, velocity.y] = smoothDamp(current.y, target.y, velocity.y, smoothTime, dt);
  [current.z, velocity.z] = smoothDamp(current.z, target.z, velocity.z, smoothTime, dt);
}
