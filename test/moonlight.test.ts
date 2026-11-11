import { describe, expect, it } from 'vitest';
import {
  FILL_GRID_WEIGHT, MOONLIGHT_FILL_CLEAR, MOONLIGHT_FILL_COPPER, PENUMBRAL_LIMIT,
  eclipseLevel, moonlightReport,
  type EclipseLevel, type MoonlightReport,
} from '../src/moonlight.js';
import { celestialLights, sampleFromLinear, sampleLightGrid, type LightGrid, type Vec3 } from '../src/light.js';
import { DEFAULT_CAMERA, resolveConditions, type AtmosphereState, type Camera } from '../src/state.js';

const ASPECT = 16 / 9;

/** a clear night, with the nominal full moon up and the sun well down */
function nightState(eclipse = 0): AtmosphereState {
  return { ...resolveConditions({ time: 23, weather: 'clear' }), moonEclipse: eclipse };
}

const gridOf = (cells: Vec3[], cols: number, rows: number): LightGrid => ({
  cols, rows, cells: cells.map((c) => sampleFromLinear(c)),
});

/** every number in a report must be finite — NaN is the failure this module exists to prevent */
function expectAllFinite(r: MoonlightReport) {
  const walk = (v: unknown) => {
    if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(r);
}

describe('eclipseLevel', () => {
  it('splits the umbral fraction into four explicit bands with stated boundaries', () => {
    expect(eclipseLevel(0)).toBe<EclipseLevel>('none');
    expect(eclipseLevel(-0.4)).toBe('none');
    expect(eclipseLevel(PENUMBRAL_LIMIT)).toBe('penumbral');       // the boundary itself stays penumbral
    expect(eclipseLevel(0.0001)).toBe('penumbral');
    expect(eclipseLevel(0.5)).toBe('partial');
    expect(eclipseLevel(0.999)).toBe('partial');
    expect(eclipseLevel(1)).toBe('total');
    expect(eclipseLevel(1.7)).toBe('total');                        // clamped, not extrapolated
  });
});

describe('moonlightReport — eclipse bands', () => {
  it('no eclipse: level none, nothing to fill, color at the uneclipsed moonlight', () => {
    const r = moonlightReport(nightState(0), DEFAULT_CAMERA, ASPECT, null);
    expect(r.moonIsKey).toBe(true);
    expect(r.eclipse.level).toBe('none');
    expect(r.eclipse.umbra).toBe(0);
    expect(r.eclipse.retained).toBe(1);
    expect(r.eclipse.attenuation).toBe(0);
    expect(r.fillNeeded).toBe(false);
    r.fillColor.forEach((c, i) => expect(c).toBeCloseTo(MOONLIGHT_FILL_CLEAR[i], 12));
    expectAllFinite(r);
  });

  it('penumbral-grade eclipse: a sliver of umbra, barely any attenuation', () => {
    const r = moonlightReport(nightState(0.03), DEFAULT_CAMERA, ASPECT);
    expect(r.eclipse.level).toBe('penumbral');
    expect(r.fillNeeded).toBe(true);
    expect(r.eclipse.retained).toBeCloseTo(1 - 0.9 * 0.03, 12);
    expect(r.eclipse.attenuation).toBeCloseTo(0.027, 12);
    // the fill has only started to leave the clear-moonlight color: under 2%
    // of the full clear→copper distance on every channel, and still nearer clear
    for (let i = 0; i < 3; i++) {
      const span = Math.abs(MOONLIGHT_FILL_CLEAR[i] - MOONLIGHT_FILL_COPPER[i]);
      expect(Math.abs(r.fillColor[i] - MOONLIGHT_FILL_CLEAR[i])).toBeLessThan(0.031 * span);
      expect(Math.abs(r.fillColor[i] - MOONLIGHT_FILL_CLEAR[i]))
        .toBeLessThan(Math.abs(r.fillColor[i] - MOONLIGHT_FILL_COPPER[i]));
    }
    expectAllFinite(r);
  });

  it('a partial eclipse sits between the two color ends', () => {
    const r = moonlightReport(nightState(0.5), DEFAULT_CAMERA, ASPECT);
    expect(r.eclipse.level).toBe('partial');
    for (let i = 0; i < 3; i++) {
      expect(r.fillColor[i]).toBeGreaterThan(Math.min(MOONLIGHT_FILL_CLEAR[i], MOONLIGHT_FILL_COPPER[i]));
      expect(r.fillColor[i]).toBeLessThan(Math.max(MOONLIGHT_FILL_CLEAR[i], MOONLIGHT_FILL_COPPER[i]));
    }
  });

  it('totality: 90% of the moonlight gone and a distinctly copper-red fill', () => {
    const r = moonlightReport(nightState(1), DEFAULT_CAMERA, ASPECT);
    expect(r.eclipse.level).toBe('total');
    expect(r.eclipse.retained).toBeCloseTo(0.1, 12);
    expect(r.eclipse.attenuation).toBeCloseTo(0.9, 12);
    expect(r.fillNeeded).toBe(true);
    r.fillColor.forEach((c, i) => expect(c).toBeCloseTo(MOONLIGHT_FILL_COPPER[i], 12));
    // copper-red: red dominates, blue is nearly gone
    expect(r.fillColor[0]).toBeGreaterThan(3 * r.fillColor[1]);
    expect(r.fillColor[1]).toBeGreaterThan(2 * r.fillColor[2]);
    expect(r.fillColor[0] / MOONLIGHT_FILL_CLEAR[0]).toBeLessThan(1);
  });

  it('the reported intensity is exactly celestialLights moonlight, weakened by the same retained factor', () => {
    const s = nightState(0.4);
    const r = moonlightReport(s, DEFAULT_CAMERA, ASPECT);
    const moon = celestialLights(s, DEFAULT_CAMERA, ASPECT).moon;
    const full = celestialLights({ ...s, moonEclipse: 0 }, DEFAULT_CAMERA, ASPECT).moon;
    expect(r.moonlightIntensity).toBe(moon.intensity);
    expect(r.moonVisibility).toBe(moon.visibility);
    expect(moon.intensity / full.intensity).toBeCloseTo(r.eclipse.retained, 12);
  });

  it('agrees with celestialLights on whether the moon is the key light', () => {
    const s = nightState(0.6);
    const r = moonlightReport(s, DEFAULT_CAMERA, ASPECT);
    expect(r.moonIsKey).toBe(celestialLights(s, DEFAULT_CAMERA, ASPECT).key === 'moon');
  });
});

describe('moonlightReport — the no-fill cases', () => {
  it('a moon below the horizon needs no fill and the report carries no NaN', () => {
    const noon = { ...resolveConditions({ time: 12, weather: 'clear' }), moonEclipse: 1 };
    const r = moonlightReport(noon, DEFAULT_CAMERA, ASPECT);
    expect(r.moonVisibility).toBe(0);
    expect(r.moonlightIntensity).toBe(0);
    expect(r.fillNeeded).toBe(false);
    // the geometry of the eclipse is still reported honestly
    expect(r.eclipse.level).toBe('total');
    expectAllFinite(r);
  });

  it('a visible moon with zero umbra also needs no fill', () => {
    const r = moonlightReport(nightState(0), DEFAULT_CAMERA, ASPECT);
    expect(r.moonVisibility).toBeGreaterThan(0);
    expect(r.fillNeeded).toBe(false);
  });

  it('clamps out-of-range umbra inputs instead of producing NaN', () => {
    const hot = moonlightReport(nightState(4), DEFAULT_CAMERA, ASPECT);
    expect(hot.eclipse.umbra).toBe(1);
    expect(hot.eclipse.level).toBe('total');
    const cold = moonlightReport(nightState(-2), DEFAULT_CAMERA, ASPECT);
    expect(cold.eclipse.umbra).toBe(0);
    expect(cold.eclipse.level).toBe('none');
    expectAllFinite(hot);
    expectAllFinite(cold);
  });
});

describe('moonlightReport — screen sampling', () => {
  it('with no probe grid it degrades to the fill color alone', () => {
    const r = moonlightReport(nightState(0.7), DEFAULT_CAMERA, ASPECT, null);
    expect(r.sampling.mode).toBe('no-grid');
    expect(r.sampling.reason).toBe('no-grid');
    expect(r.sampling.position).toBeNull();
    expect(r.finalFill).toEqual(r.fillColor);
  });

  it('defaults to the no-grid path when the grid argument is omitted', () => {
    const r = moonlightReport(nightState(0.7), DEFAULT_CAMERA, ASPECT);
    expect(r.sampling.mode).toBe('no-grid');
    expect(r.finalFill).toEqual(r.fillColor);
  });

  it('never uses the screen position when the moon is behind the camera', () => {
    const s = nightState(0.7);
    const behind: Camera = { yaw: s.moonAzimuth + Math.PI, pitch: 0, fov: 0.9 };
    expect(celestialLights(s, behind, ASPECT).moon.screen.inFront).toBe(false);
    const grid = gridOf([[0.2, 0.3, 0.4], [0.5, 0.6, 0.7]], 2, 1);
    const r = moonlightReport(s, behind, ASPECT, grid);
    expect(r.sampling.mode).toBe('behind-camera');
    expect(r.sampling.reason).toBe('behind-camera');
    expect(r.sampling.position).toBeNull();
    expect(r.finalFill).toEqual(r.fillColor);
  });

  it('with a grid it samples near the moon and blends in linear light, not encoded values', () => {
    const s = nightState(0.7);
    // look straight at the moon: it lands on the screen centre (0.5, 0.5)
    const cam: Camera = { yaw: s.moonAzimuth, pitch: s.moonElevation, fov: 0.9 };
    const grid = gridOf([[0, 0, 0], [1, 1, 1]], 2, 1);
    const r = moonlightReport(s, cam, ASPECT, grid);

    expect(r.sampling.mode).toBe('grid');
    expect(r.sampling.reason).toBeNull();
    expect(r.sampling.position).not.toBeNull();
    expect(r.sampling.position!.x).toBeCloseTo(0.5, 9);
    expect(r.sampling.position!.y).toBeCloseTo(0.5, 9);

    // centre of a black/white 2×1 grid is a linear 50% grey …
    const at = sampleLightGrid(grid, 0.5, 0.5);
    expect(at.linear[0]).toBeCloseTo(0.5, 12);
    // … whose encoded value sits well above 0.5 — the signature of linear averaging
    expect(at.srgb[0]).toBeGreaterThan(0.7);

    for (let i = 0; i < 3; i++) {
      const expected = r.fillColor[i] * (1 - FILL_GRID_WEIGHT) + at.linear[i] * FILL_GRID_WEIGHT;
      expect(r.finalFill[i]).toBeCloseTo(expected, 12);
    }
    // it must not be the average against the encoded (sRGB) value
    const wrong = r.fillColor[0] * (1 - FILL_GRID_WEIGHT) + at.srgb[0] * FILL_GRID_WEIGHT;
    expect(r.finalFill[0]).not.toBeCloseTo(wrong, 3);
  });

  it('clamps an out-of-frame screen position to 0..1 before reading the grid', () => {
    const s = nightState(0.4);
    // moon still in front, but a narrow fov pitches it outside the frame
    const cam: Camera = { yaw: s.moonAzimuth + 0.5, pitch: s.moonElevation, fov: 0.4 };
    const lights = celestialLights(s, cam, ASPECT);
    expect(lights.moon.screen.inFront).toBe(true);
    const grid = gridOf([[0.1, 0.2, 0.3]], 1, 1);
    const r = moonlightReport(s, cam, ASPECT, grid);
    expect(r.sampling.mode).toBe('grid');
    expect(r.sampling.position!.x).toBeGreaterThanOrEqual(0);
    expect(r.sampling.position!.x).toBeLessThanOrEqual(1);
    expect(r.sampling.position!.y).toBeGreaterThanOrEqual(0);
    expect(r.sampling.position!.y).toBeLessThanOrEqual(1);
  });

  it('a bad aspect ratio falls back to 1 instead of NaN-ing the screen position', () => {
    const r = moonlightReport(nightState(0.4), DEFAULT_CAMERA, NaN, null);
    expect(r.sampling.mode).toBe('no-grid');
    expectAllFinite(r);
    expect(moonlightReport(nightState(0.4), DEFAULT_CAMERA, 0, null).eclipse.level).toBe('partial');
  });
});
