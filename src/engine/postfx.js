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

// UnrealBloomPass's high-pass reads the scene buffer and hands whatever it
// finds to a separable blur. A blur has no way to contain a bad texel: one NaN
// or Inf in the input spreads to every tap that touches it, then up the mip
// chain, and the composite adds the result back over the whole frame. The
// composer's target is HalfFloat, so an overflow past 65504 is Inf rather than
// a clipped white, and Inf - Inf inside the blur is NaN. NaN written to an
// 8-bit canvas is transparent black, so a single bad texel anywhere in the
// scene can turn the entire play area into bare page background.
//
// That is not hypothetical: the exit portal's light shaft was producing 17 NaN
// vertex alphas (see world.js), and it black-screened both post-processing
// tiers. The shaft is fixed, but "one bad texel blanks the game" is too sharp
// an edge to leave in place, so the high-pass now drops non-finite texels to
// zero. Two ternaries in a pass that already runs per pixel; unmeasurable.
//
// The comparison has to be a ternary rather than a multiply: NaN compares false
// against everything, but `0.0 * NaN` is still NaN, so masking cannot work.
function sanitizeHighPass(pass) {
  const mat = pass?.materialHighPassFilter;
  const marker = 'vec4 texel = texture2D( tDiffuse, vUv );';
  if (!mat || !mat.fragmentShader.includes(marker)) return;
  mat.fragmentShader = mat.fragmentShader.replace(marker, `${marker}
    bvec4 finite = lessThan( abs( texel ), vec4( 65504.0 ) );
    texel = vec4(
      finite.x ? texel.x : 0.0, finite.y ? texel.y : 0.0,
      finite.z ? texel.z : 0.0, finite.w ? texel.w : 0.0 );`);
  mat.needsUpdate = true;
}

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
    sanitizeHighPass(bloom);
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

  const api = {
    composer,
    bloom,
    render(dt) { composer.render(dt); },
    // Width and height are CSS pixels; the composer multiplies by the pixel
    // ratio itself. The ratio is set *after* the size, and that order is the
    // whole point: EffectComposer.setPixelRatio re-runs setSize(this._width,
    // this._height), so whatever _width holds when it is called is what gets
    // multiplied. Ratio-first multiplied a _width that had been seeded from the
    // target we handed the constructor -- which is already in device pixels --
    // and allocated a 4598 x 2876 HalfFloat target with 4x MSAA, about 400MB,
    // for the one frame before the correct size landed. Size-first means the
    // largest allocation on any path is the one we actually want.
    setSize(w, h) {
      composer.setSize(w, h);
      composer.setPixelRatio(renderer.getPixelRatio());
    },
    dispose() {
      for (const pass of composer.passes) pass.dispose?.();
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
    },
  };

  // Refuse to hand back a chain that cannot present. A render target can fail
  // to allocate on a constrained driver -- too large, out of memory, an
  // unsupported sample count -- and WebGL reports that only as an incomplete
  // framebuffer: no exception, no GL error, no lost context, just a black
  // screen. The caller falls back to drawing straight to the canvas, which is
  // the low tier's path and always works.
  const gl = renderer.getContext();
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.renderTarget1);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  renderer.setRenderTarget(before);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.warn(`[postfx] scene target incomplete (0x${status.toString(16)}); drawing without post-processing`);
    api.dispose();
    return null;
  }

  return api;
}
