/**
 * Simulation constants shared across the project.
 *
 * Everything here is fixed rather than tuned at runtime, because the whole game
 * depends on a genome producing the *same* run every time it is simulated. Any
 * value that varies between runs would break sharing via URL.
 */

/** Physics steps per second. Fixed, never derived from frame rate. */
export const PHYSICS_HZ = 60;

/** Seconds advanced by one physics step. */
export const FIXED_DT = 1 / PHYSICS_HZ;

/** How long a race lasts, in seconds. */
export const RACE_SECONDS = 15;

/** Total physics steps in one race. Deterministic by construction. */
export const RACE_STEPS = RACE_SECONDS * PHYSICS_HZ;

/** Downward acceleration, metres per second squared. */
export const GRAVITY = { x: 0, y: -9.81, z: 0 };

/**
 * Rapier interaction groups.
 *
 * The upper 16 bits are "what group am I in", the lower 16 are "what groups do
 * I collide with". Creature parts deliberately do not collide with each other:
 * self-collision between limbs makes random creatures explode or lock up, and
 * Sims disabled it too. Parts collide with the ground and nothing else.
 */
export const GROUP_GROUND = 0x0001;
export const GROUP_CREATURE = 0x0002;

/** Collider filter for a creature part: is a creature, collides only with ground. */
export const CREATURE_GROUPS = (GROUP_CREATURE << 16) | GROUP_GROUND;

/** Collider filter for the ground: is ground, collides only with creatures. */
export const GROUND_GROUPS = (GROUP_GROUND << 16) | GROUP_CREATURE;
