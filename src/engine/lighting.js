// Three-point lighting rig, per-theme colour temperature, and a shadow camera
// that is refitted to the actual board every time the view changes.
//
// The old rig was one directional light plus a hemisphere wash, which gave
// every world the same white noon and left star shadows as hard black blobs.
// Here the key light does the modelling, a cool fill keeps the shaded sides
// from going dead, and a rim from behind separates the island silhouette from
// the sky. Ambient comes from the environment map (see sky.js), not a hemi
// light, so it always matches the sky the player can actually see.
import * as THREE from 'three';
import { flags } from './quality.js';

// Penumbra width in *world units*, not texels. Shadow softness has to be a
// property of the scene, not of the shadow map: fitting the frustum tightly
// (which we now do) shrinks the texel, and a fixed texel radius would make a
// five-tile board's shadows razor sharp and a nine-tile board's mushy.
const SOFTNESS = { on: 0.036, off: 0.018 };

// The fill and rim directions are fixed relative to the world, not the sun:
// the sun moves per theme, but the camera never does, so the light that
// separates the silhouette has to stay put or worlds stop matching each other.
//
// FILL_DIR is now almost horizontal. Raised (the old 0.42/0.55) it came at the
// camera-facing tile lips nearly head-on -- dot 0.54 against the lip, 0.41
// against the tile top -- so the fill lit the *side* of a step harder than its
// top. With a lip albedo of 0.69x the top's (tilePalette in world.js) that was
// enough to erase the step entirely in Worlds 2 and 3 and to invert it in
// World 4. Grazing in from -X it still opens up the shaded cliffs, which is its
// actual job, without competing with the key on anything facing upwards.
const FILL_DIR = new THREE.Vector3(-0.75, 0.15, 0.30).normalize();
const RIM_DIR = new THREE.Vector3(0.25, 0.55, -0.95).normalize();

// Ceiling on the fill, whatever a theme asks for. A fill is there to keep the
// shaded planes off the floor, not to model; past this it starts flattening the
// very forms the key is carving. World 2 asked for 0.75, which on its own was
// most of the reason its tile tops and tile sides measured the same value.
const MAX_FILL = 0.40;

export function createRig(scene) {
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.castShadow = true;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.copy(FILL_DIR).multiplyScalar(20);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  rim.position.copy(RIM_DIR).multiplyScalar(20);
  scene.add(rim);

  const sunDir = new THREE.Vector3(0.45, 0.8, 0.5);

  applyShadowQuality();

  function applyShadowQuality() {
    const f = flags();
    key.castShadow = f.shadows;
    key.shadow.mapSize.setScalar(f.shadowMapSize);
    // Freeing the existing map forces three to reallocate at the new size.
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    // Shadows that go all the way to the ambient floor read as holes punched
    // in the board. Holding a little light back, and letting the environment
    // map fill the rest, is what turns the old black blobs into tinted shapes.
    key.shadow.intensity = 0.78;
  }

  return {
    key, fill, rim,

    apply(theme) {
      key.color.setHex(theme.key);
      key.intensity = theme.keyIntensity;
      fill.color.setHex(theme.fill);
      fill.intensity = Math.min(theme.fillIntensity, MAX_FILL);
      rim.color.setHex(theme.rim);
      rim.intensity = theme.rimIntensity;
      sunDir.fromArray(theme.sunDir).normalize();
    },

    // Fit the shadow frustum to the board's bounding sphere. The old fixed
    // +/-12 box spent most of the shadow map on empty sky: a five-tile World 1
    // board used about 4% of it, which is exactly why those shadows were a
    // noisy mess.
    fit(center, spanX, spanZ) {
      const radius = Math.hypot(spanX / 2 + 1.0, spanZ / 2 + 1.0, 1.8);
      const dist = radius * 2.0 + 8;
      key.position.copy(center).addScaledVector(sunDir, dist);
      key.target.position.copy(center);
      key.target.updateMatrixWorld();

      const cam = key.shadow.camera;
      cam.left = -radius; cam.right = radius;
      cam.top = radius; cam.bottom = -radius;
      cam.near = Math.max(0.5, dist - radius - 4);
      cam.far = dist + radius + 4;
      cam.updateProjectionMatrix();

      // Bias scaled to the world size of one shadow texel. Constant bias in a
      // fitted frustum is the classic way to get acne on small boards and
      // peter-panning on large ones.
      const f = flags();
      const texel = (radius * 2) / f.shadowMapSize;
      key.shadow.bias = -texel * 0.35;
      key.shadow.normalBias = Math.max(0.012, texel * 2.2);
      // three r185 samples a 5-tap Vogel disk of `radius` texels, jittered per
      // pixel. Converting a world-space penumbra into texels keeps the look
      // constant across board sizes and tiers; the clamp stops a tiny board
      // from spreading five taps so wide that the dither becomes visible.
      key.shadow.radius = Math.min(
        Math.max((f.softShadows ? SOFTNESS.on : SOFTNESS.off) / texel, 1), 9,
      );
      key.shadow.needsUpdate = true;
    },

    applyShadowQuality,

    dispose() {
      key.shadow.map?.dispose();
      scene.remove(key, key.target, fill, rim);
      key.dispose(); fill.dispose(); rim.dispose();
    },
  };
}
