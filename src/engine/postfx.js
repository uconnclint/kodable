// Post-processing chain. Entirely optional: on the low tier nothing here is
// constructed and the renderer draws straight to the default framebuffer.
//
// The chain is deliberately short -- RenderPass, a restrained bloom, OutputPass
// -- because this is a puzzle game for six-year-olds on tablets. Bloom is here
// to make the exit portal, the stars and the crystals *glow*, not to soften the
// frame; anything that smears the board makes the puzzle harder to read, which
// the brief calls a failure regardless of how it looks.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { flags } from './quality.js';

// Threshold is luminance in linear scene-referred light, before tone mapping.
// The lighting rig is set so a white surface facing the key lands a shade over
// 1.0 and everything else below it, which puts the threshold right at the top
// of the diffuse range: emissive trim, the portal, the crystals and the start
// pad clear it, ordinary lit tiles do not. Strength is low on purpose -- at
// 0.4 the effect ate Bloop's face, and a puzzle you cannot read is a failure
// however pretty the glow is.
const BLOOM_STRENGTH = 0.22;
const BLOOM_RADIUS = 0.6;
const BLOOM_THRESHOLD = 1.0;

export function createComposer(renderer, scene, camera) {
  const f = flags();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  // Our own target rather than the composer's default, so MSAA happens on the
  // scene render itself. That is far cheaper and far better looking than
  // bolting an FXAA/SMAA pass on the end of the chain, and it keeps the chunky
  // silhouettes this art style lives on crisp instead of smeared.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: f.msaaSamples,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  target.texture.name = 'blooptopia.scene';

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  let bloom = null;
  if (f.bloom) {
    bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD,
    );
    composer.addPass(bloom);
  }

  // No ambient-occlusion pass, even on the high tier (`flags().ao` is false
  // everywhere). GTAOPass was tried and rejected: this scene is a few hundred
  // large flat-shaded faces with almost no concave geometry, so AO has nothing
  // to find except the tile-to-tile seams -- where it draws exactly the dark
  // outline that makes a five-tile path read as five separate islands. It also
  // wants its own depth+normal prepass, which is the single most expensive
  // thing we could add on a tablet. The flag stays in the tier table so a
  // future effect can claim it without another API change.

  // OutputPass owns tone mapping and the sRGB conversion once a composer is in
  // play. The scene materials skip both automatically, because three only
  // compiles tone mapping into a material when it is drawing to the default
  // framebuffer -- so there is no double application to guard against.
  composer.addPass(new OutputPass());

  return {
    composer,
    bloom,
    render(dt) { composer.render(dt); },
    // Width and height are CSS pixels; the composer multiplies by the pixel
    // ratio itself. Setting the ratio first matters because the target we
    // handed the constructor was already sized in device pixels, which leaves
    // the composer's own bookkeeping out of step until the first resize.
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
    dispose() {
      for (const pass of composer.passes) pass.dispose?.();
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
    },
  };
}
