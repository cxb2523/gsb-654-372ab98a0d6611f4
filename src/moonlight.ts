// moonlight.ts — a fill-light verdict for a moon in the Earth's shadow
//
// celestialLights() already dims and coppers the moon as an eclipse deepens,
// but it leaves the foreground to guess what that means: how much of the
// moonlight is actually gone, and what should fill the gap. This module reads
// the same state and gives an explicit answer — a "moonlight report" — that a
// foreground renderer can light with directly.
//
// Everything here is pure and CPU-side, like light.ts itself. The probe's
// frame grid is folded in only when one is handed over, so a report can be
// built before any probe has run.

import {
  celestialLights, sampleLightGrid,
  type LightGrid, type LightSample, type Vec3,
} from './light.js';
import type { AtmosphereState, Camera } from './state.js';

/** How far the moon stands in the Earth's shadow */
export type EclipseLevel = 'none' | 'penumbral' | 'partial' | 'total';

/** Why the fill color stands alone, instead of being blended with the grid */
export type FillGridFallback = 'no-grid' | 'behind-camera';

/**
 * The boundaries of the eclipse bands, as fractions of the disc inside the
 * Earth's umbra (the same 0..1 figure `AtmosphereState.moonEclipse` carries).
 *
 * `state.ts` only records the umbral fraction, not the penumbral one, so a
 * moon that merely grazes the umbra cannot be told from a purely penumbral
 * eclipse: the first sliver of umbra, up to and including
 * {@link PENUMBRAL_LIMIT}, is reported as `penumbral`.
 */
export const PENUMBRAL_LIMIT = 0.05;
/** umbra at or above this fraction of the disc is a total eclipse */
export const TOTAL_LIMIT = 1;

/**
 * How the suggested fill is weighted against the measured frame when the
 * probe grid is sampled. Half and half: the grid grounds the fill in what the
 * sky actually looks like, the fill keeps the eclipse's copper tint.
 */
export const FILL_GRID_WEIGHT = 0.5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB display triplet → linear RGB (the inverse of light.ts's `encode`) */
function linearOf(display: Vec3): Vec3 {
  return [decode(display[0]), decode(display[1]), decode(display[2])];
}

/**
 * The fill color at the two ends of an eclipse, in linear light.
 *
 * The uneclipsed end is the moon's own display color in {@link celestialLights}
 * (`[1, 0.96, 0.88]`) decoded to linear, so with no eclipse the suggestion is
 * simply the moonlight that is already there. The total end is the deep
 * copper-red of a blood moon: only sunlight bent through the Earth's sunsets
 * reaches the disc then, so the fill that replaces the lost light carries that
 * same color. Between them the color is mixed in linear light.
 */
const FILL_LINEAR: Readonly<Record<'clear' | 'copper', Vec3>> = {
  clear: linearOf([1.0, 0.96, 0.88]),
  copper: linearOf([0.85, 0.27, 0.1]),
};

const mixLinear = (a: Vec3, b: Vec3, k: number): Vec3 => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];

/**
 * Classify the eclipse from the umbral fraction (clamped to 0..1).
 *
 * Boundaries, with `u` the clamped umbra:
 *   - `u === 0`            → none
 *   - `0 < u <= 0.05`      → penumbral
 *   - `0.05 < u < 1`       → partial
 *   - `u >= 1`             → total
 */
export function eclipseLevel(umbra: number): EclipseLevel {
  const u = clamp01(umbra);
  if (u <= 0) return 'none';
  if (u <= PENUMBRAL_LIMIT) return 'penumbral';
  if (u < TOTAL_LIMIT) return 'partial';
  return 'total';
}

/** Where the fill light should be sampled on screen, or why that is not possible */
export interface FillScreenSample {
  /**
   * How the final fill color was produced:
   *   - `grid`     — blended in linear light with a `sampleLightGrid` read
   *   - `no-grid`  — the probe passed no frame grid, so the fill stands alone
   *   - `behind-camera` — the moon is behind the camera; its screen position
   *                       is meaningless, so the fill stands alone
   */
  mode: 'grid' | FillGridFallback;
  /** screen point used for the grid read, 0..1 from the top-left; null outside grid mode */
  position: { x: number; y: number } | null;
  /** set when `mode` is not `grid`, explaining the fallback */
  reason: FillGridFallback | null;
}

/**
 * A fill-light verdict for the moon in this state, seen through this camera.
 */
export interface MoonlightReport {
  /**
   * Whether the moon is the scene's key light — the exact `key === 'moon'`
   * decision {@link celestialLights} makes.
   */
  moonIsKey: boolean;
  /** the classified eclipse, geometrically (reported even when the moon is down) */
  eclipse: {
    level: EclipseLevel;
    /** the umbral fraction after clamping, 0..1 */
    umbra: number;
    /** the fraction of the uneclipsed moonlight that remains, `1 - 0.9·umbra` — the same factor the shader and celestialLights apply */
    retained: number;
    /** how much of the moonlight the eclipse removed, `1 - retained` */
    attenuation: number;
  };
  /** the moon's own light after the eclipse, in the renderer's emission scale (a clear sun is 1; see MOON_RELATIVE) */
  moonlightIntensity: number;
  /** the moon's 0..1 get-through, straight from celestialLights */
  moonVisibility: number;
  /**
   * The suggested foreground fill color, linear RGB. Near the uneclipsed
   * moonlight color when there is no eclipse, distinctly copper-red in
   * totality. Defined in every report — including the no-fill ones — so a
   * caller never has to guard against NaN.
   */
  fillColor: Vec3;
  /**
   * False when there is nothing to compensate: the moon is not getting
   * through (visibility 0) or no part of it is in the umbra. The other
   * numbers stay valid; this is the explicit "no fill needed" marker.
   */
  fillNeeded: boolean;
  /** the screen sampling behind {@link fillColor}'s grid blend */
  sampling: FillScreenSample;
  /**
   * The fill color actually to light with: the linear-light average of
   * {@link fillColor} and the grid sample around the moon's screen position
   * when a grid exists and the moon is in front of the camera; otherwise
   * {@link fillColor} untouched. Never an interpolation of encoded values.
   */
  finalFill: Vec3;
}

/**
 * Build the moonlight report for a state, camera and frame aspect ratio.
 *
 * `aspect` is width over height; only the moon's screen position depends on
 * it. A non-finite or non-positive aspect is treated as 1. `grid` is the
 * probe's frame grid (see {@link summarizeProbe}), or null when no probe has
 * run — in which case the report degrades to the fill color alone.
 *
 * Coordinates follow the renderer's conventions: directions in world axes
 * (x east, y up, z north), screen positions 0..1 with the origin at the
 * top-left. All 0..1 inputs are clamped; no field is ever NaN.
 */
export function moonlightReport(
  s: AtmosphereState,
  camera: Camera,
  aspect: number,
  grid: LightGrid | null = null,
): MoonlightReport {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const { moon, key } = celestialLights(s, camera, safeAspect);

  const umbra = clamp01(s.moonEclipse ?? 0);
  const level = eclipseLevel(umbra);
  // mirror the (1 − 0.9·eclipse) factor in celestialLights / the sky shader
  const retained = 1 - 0.9 * umbra;
  const attenuation = 1 - retained;

  const visible = clamp01(moon.visibility) > 0;
  const fillNeeded = visible && umbra > 0;

  // mix toward the blood-moon copper by the umbral fraction, in linear light
  const fillColor = mixLinear(FILL_LINEAR.clear, FILL_LINEAR.copper, umbra);

  let gridSample: LightSample | null = null;
  let sampling: FillScreenSample;
  if (!moon.screen.inFront) {
    sampling = { mode: 'behind-camera', position: null, reason: 'behind-camera' };
  } else if (!grid) {
    sampling = { mode: 'no-grid', position: null, reason: 'no-grid' };
  } else {
    // sampleLightGrid holds the edges itself, but the 0..1 contract is ours too
    const position = { x: clamp01(moon.screen.x), y: clamp01(moon.screen.y) };
    gridSample = sampleLightGrid(grid, position.x, position.y);
    sampling = { mode: 'grid', position, reason: null };
  }

  const finalFill: Vec3 = gridSample
    ? mixLinear(fillColor, gridSample.linear, FILL_GRID_WEIGHT)
    : fillColor;

  return {
    moonIsKey: key === 'moon',
    eclipse: { level, umbra, retained, attenuation },
    moonlightIntensity: moon.intensity,
    moonVisibility: moon.visibility,
    fillColor,
    fillNeeded,
    sampling,
    finalFill,
  };
}

/** The uneclipsed moonlight fill color, in linear light (exported for tests and reuse) */
export const MOONLIGHT_FILL_CLEAR: Vec3 = [...FILL_LINEAR.clear];
/** The total-eclipse blood-moon fill color, in linear light */
export const MOONLIGHT_FILL_COPPER: Vec3 = [...FILL_LINEAR.copper];
