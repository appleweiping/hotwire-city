// config.js — single source of truth for every tunable number in the game.
// Units: pixels, seconds, radians. Angle 0 points +x, clockwise positive (y-down screen space).

export const VIEW_W = 1280;          // logical viewport width — gameplay never sees other sizes
export const VIEW_H = 720;
export const STEP = 1 / 60;          // fixed simulation timestep
export const MAX_FRAME_DELTA = 0.25; // clamp huge rAF gaps (tab switch) to avoid spiral of death

export const TILE = 32;
// 92 = 2×water + 8×(4-wide road) + 7×(8-wide block): the only symmetric fit
// for a perimeter ring road + 7×7 block grid (8 + 12n must equal the size).
export const MAP_W = 92;             // tiles
export const MAP_H = 92;
export const WORLD_W = MAP_W * TILE; // 3072
export const WORLD_H = MAP_H * TILE;
export const MAP_SEED = 1337;        // same seed → same city (deterministic PRNG)

// Tile types (stored in a Uint8Array)
export const T = {
  ROAD_H: 0,
  ROAD_V: 1,
  ROAD_CROSS: 2,
  SIDEWALK: 3,
  BUILDING: 4,
  GRASS: 5,
  WATER: 6,
};

// City layout: every BLOCK_PERIOD tiles, a ROAD_LANES-wide road band (both axes).
export const CITY = {
  BLOCK_PERIOD: 12,
  ROAD_LANES: 4,        // road band width in tiles (2 lanes each way visually)
  WATER_BORDER: 2,      // water tiles ringing the map edge
  PARK_CHANCE: 0.15,    // chance a block becomes a park
  LANE_OFFSET: 32,      // lane centerline offset from road band center (right-hand traffic)
};

export const PLAYER = {
  RADIUS: 7,
  WALK_SPEED: 110,
  SPRINT_SPEED: 170,
  MAX_HP: 100,
  CAR_HIT_MIN_SPEED: 80,     // below this a car only shoves the player
  CAR_HIT_DMG_SCALE: 0.35,   // dmg = (speed - min) * scale
  KNOCKDOWN_TIME: 0.8,
  HIT_INVULN_TIME: 0.5,
  RESPAWN_INVULN_TIME: 2.0,
  MAX_PASSIVE_PUSH: 12,      // max px an entity can be shoved per tick (anti wall-clip)
};

// Vehicle handling per type. grip is the whole drift model:
// lateral velocity decays as exp(-grip * dt); handbrake swaps in gripHand.
export const VEHICLE_TYPES = {
  sedan:  { accel: 180, vMax: 260, revMax: 90,  brake: 450, coast: 90,  steer: 2.6, grip: 8.0, gripHand: 2.2, w: 40, h: 20, hp: 100, mass: 1.0 },
  sports: { accel: 260, vMax: 340, revMax: 100, brake: 500, coast: 80,  steer: 3.0, grip: 6.5, gripHand: 2.0, w: 42, h: 18, hp: 80,  mass: 0.9 },
  police: { accel: 220, vMax: 300, revMax: 100, brake: 480, coast: 90,  steer: 2.8, grip: 8.5, gripHand: 2.4, w: 42, h: 20, hp: 120, mass: 1.1 },
  truck:  { accel: 100, vMax: 200, revMax: 70,  brake: 350, coast: 100, steer: 1.8, grip: 9.0, gripHand: 3.0, w: 56, h: 26, hp: 200, mass: 2.2 },
};
// Civilian traffic spawn weights
export const TRAFFIC_MIX = [ ['sedan', 0.70], ['sports', 0.15], ['truck', 0.15] ];

export const VEHICLE = {
  OFFROAD_VMAX_SCALE: 0.6,     // driving on sidewalk/grass
  OFFROAD_GRIP_SCALE: 0.8,
  WALL_DMG_MIN_SPEED: 60,      // scraping below this is free (sparks only)
  WALL_DMG_SCALE: 0.15,
  WALL_RESTITUTION: 0.3,
  WALL_TANGENT_KEEP: 0.7,
  CAR_CAR_DMG_SCALE: 0.12,
  ENTER_DIST: 48,              // player→car center distance for E interaction
  ENTER_TIME_EMPTY: 0.3,
  ENTER_TIME_JACK: 0.5,
  JACK_MAX_SPEED: 60,          // can't jack a car moving faster than this
  EXIT_MAX_SPEED: 30,          // auto-brake to this before exiting
  SMOKE_HP: 0.6,               // hp fraction: below → grey smoke
  FIRE_HP: 0.3,                // below → fire + fuse
  FIRE_FUSE: 10,               // seconds from catching fire to explosion
  EXPLOSION_RADIUS: 60,
  EXPLOSION_DMG: 80,
  WRECK_LIFETIME: 20,
  CHAIN_EXPLOSION_DELAY: 0.2,  // chained explosions resolve via delayed queue
  MAX_EXPLOSIONS_PER_TICK: 2,
};

export const PED = {
  RADIUS: 6,
  HP: 30,
  WALK_SPEED: 60,
  FLEE_SPEED: 140,
  CAP: 24,
  SPAWN_RING: [800, 1100],     // spawn annulus around player (off-screen at 1280×720)
  DESPAWN_DIST: 1400,
  CORPSE_TIME: 15,
  CORPSE_FADE: 2,
  PANIC_GUNSHOT_R: 250,
  PANIC_VIOLENCE_R: 200,
  PANIC_SCREAM_R: 100,         // fleeing peds re-broadcast weak panic
  PANIC_SCREAM_INTERVAL: 2,
  FLEE_ESCAPE_DIST: 500,
  FLEE_CALM_TIME: 8,
  KNOCKDOWN_MIN_SPEED: 40,     // car speed: knockdown
  KILL_MIN_SPEED: 90,          // car speed: instant kill
  TURN_CHANCE: 0.30,           // chance to turn at each sidewalk tile
};

export const TRAFFIC = {
  CAP: 12,
  CRUISE_SPEED: 140,
  SPAWN_RING: [800, 1100],
  DESPAWN_DIST: 1600,
  PROBE_LEN: 90,               // forward obstacle probe box
  PROBE_W: 24,
  STOP_DIST: 25,               // fully stopped at this distance to obstacle
  LOOKAHEAD: 64,               // steering target: this far ahead on lane centerline
  STEER_GAIN: 3,
  BLOCKED_TIMEOUT: 5,          // stuck this long → recycle (off-screen) / reverse retry (on-screen)
  REVERSE_RETRY_DIST: 20,
  MAX_RETRIES: 2,
};

export const COP = {
  RADIUS: 7,
  HP: 40,
  RUN_SPEED: 150,
  ARREST_DIST: 24,
  ARREST_MAX_PLAYER_SPEED: 40,
  ARREST_TIME: 1.2,
  SHOOT_RANGE_MIN: 150,        // keeps this distance while shooting
  SHOOT_RANGE_MAX: 300,
  SIGHT_DIST: 450,             // engage distance (with LOS)
  PISTOL_DMG: 8,
  PISTOL_RATE: 1.2,            // shots/sec
  PISTOL_SPREAD: 6 * Math.PI / 180,
  MOVING_TARGET_SPREAD: 6 * Math.PI / 180, // extra spread when player is moving
  SMG_RATE: 4,                 // at 4★+ cops fire faster
  LOST_TARGET_TIME: 5,         // lose LOS this long + far → investigate last known pos
  LOST_TARGET_DIST: 600,
  CAR_STOP_DIST: 150,          // police car pulls over here when player is on foot
  RAM_STARS: 3,                // stars at which police cars ram
  PREDICT_TIME: 0.5,           // chase aim-ahead of player velocity
};

export const WANTED = {
  STAR_THRESHOLDS: [10, 30, 60, 100, 150],
  STAR_HYSTERESIS: 2,          // seconds before a star level drop is applied
  HEAT_DECAY: 4,               // per second, once decay conditions met
  DECAY_QUIET_TIME: 8,         // seconds without crime AND without cop LOS
  LOS_DIST: 500,
  LOS_INTERVAL: 0.2,           // raycast throttle
  HEAT_RATE_CAP: 40,           // max heat gain per second (mowing a crowd ≠ instant 5★)
  CRIMES: {
    PED_HIT: 5,
    PED_KILL: 15,
    GUNSHOT: 10,
    CARJACK: 10,
    COP_CAR_JACK: 20,
    COP_HURT: 20,
    COP_KILL: 40,
  },
  // Per star level: [foot cops, police cars]
  ROSTER: [ [2, 0], [2, 0], [3, 1], [4, 3], [6, 4], [8, 6] ],
  REINFORCE_INTERVAL: 4,
  REINFORCE_INTERVAL_HIGH: 3,  // at 4★+
  ROADBLOCK_STARS: 5,
  ROADBLOCK_DIST: [500, 800],  // ahead of the player's driving direction
  ROADBLOCK_MAX: 2,
  ROADBLOCK_COOLDOWN: 12,
};

export const WEAPONS = {
  fist:   { name: 'FIST',   dmg: 10, rate: 2,  range: 24,  spread: 0,                    ammo: Infinity, melee: true },
  pistol: { name: 'PISTOL', dmg: 15, rate: 4,  range: 450, spread: 1.5 * Math.PI / 180,  ammo: 60,       melee: false },
  smg:    { name: 'SMG',    dmg: 8,  rate: 10, range: 350, spread: 4 * Math.PI / 180,    ammo: 0,        melee: false, auto: true },
  // police sidearm (not player-selectable; rate lives in COP config)
  copPistol: { name: 'COP', dmg: 8, rate: 1.2, range: 380, spread: 6 * Math.PI / 180, ammo: Infinity, melee: false },
};
export const WEAPON_ORDER = ['fist', 'pistol', 'smg'];
export const AMMO_DROP = { pistol: 20, smg: 30 };  // dead cops drop one of these (50/50)
export const PICKUP_RADIUS = 20;

export const ECONOMY = {
  PED_KILL: 10,
  COP_KILL: 50,
  CAR_DESTROY: 40,
  POLICE_CAR_DESTROY: 100,
  CARJACK: 5,
  CASH_PICKUP: 25,
  CASH_PICKUP_COUNT: 20,       // scattered on sidewalks
  CASH_RESPAWN_TIME: 60,
  SURVIVAL_BONUS: 100,         // every 30s alive at 3★+
  SURVIVAL_INTERVAL: 30,
  DEATH_PENALTY_PCT: 0.30,
  DEATH_PENALTY_MIN: 150,
  BUST_PENALTY_PCT: 0.20,
  BUST_PENALTY_MIN: 100,
  HEALTH_PICKUP: 25,           // outside the hospital
  HEALTH_RESPAWN_TIME: 15,
};

export const FX = {
  TRAUMA_DECAY: 1.5,           // screen shake trauma units/sec
  SHAKE_MAX: 12,               // px at trauma=1 (amplitude = trauma² × this)
  TRAUMA_SHOT: 0.15,
  TRAUMA_HIT: 0.25,
  TRAUMA_CRASH: 0.3,
  TRAUMA_RUNOVER: 0.4,
  TRAUMA_EXPLOSION: 0.6,
  PARTICLE_CAP: 400,
};

export const BUDGET = {
  TOTAL_ENTITIES: 60,          // soft global cap; high wanted trims ped cap first
  OFFSCREEN_AI_INTERVAL: 4,    // off-screen entities think every N ticks
};

// Daytime flat-vector palette (low saturation)
export const PALETTE = {
  road: '#3f4146',
  roadLine: '#c9c5ae',
  sidewalk: '#8b8d90',
  sidewalkEdge: '#77797c',
  grass: '#6a8f5f',
  water: '#4f7d9e',
  waterDeep: '#3d637e',
  buildings: ['#9c8d7c', '#a4653f', '#b09c62', '#7c8a99', '#8d7f96', '#6f7d6e', '#a08b8b', '#8f9aa8'],
  roofShade: 0.82,             // roof = base color × this
  hospital: '#c85450',
  police: '#3a5f8a',
  blood: '#5c1616',
  skidmark: 'rgba(30,30,32,0.55)',
};

export const COLORS = {
  hudText: '#f2efe4',
  hudDim: '#9a97a3',
  accent: '#f2b134',
  danger: '#d84a3a',
  good: '#7fc95c',
  star: '#f2c94c',
  starEmpty: 'rgba(255,255,255,0.25)',
  minimapBg: 'rgba(10,10,14,0.55)',
  letterbox: '#0d0d11',
};

export const SAVE_KEY = 'hotwire-city-save-v1';
