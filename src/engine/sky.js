// Procedural sky dome and the image-based lighting derived from it.
//
// Two things come out of one shader here, which is the point: the dome the
// player sees and the environment map every MeshStandardMaterial samples are
// the *same* gradient, so ambient light always agrees with the sky behind it.
// A flat `scene.background` colour cannot do that -- it lights nothing.
//
// Everything is generated at runtime; the game ships zero image assets.
import * as THREE from 'three';
import { flags } from './quality.js';

// Radius is comfortably inside the camera's far plane. The dome follows the
// camera every frame, so it never clips and never needs to be huge.
const SKY_RADIUS = 90;

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uSunSize;
  uniform float uSunStrength;
  uniform float uFalloff;
  uniform float uDither;
  varying vec3 vDir;

  // Cheap hash for the dither term. A large smooth gradient across a 1000px
  // screen steps every ~8 vertical pixels in 8-bit output; a sub-LSB of noise
  // dissolves the steps into grain the eye reads as "smooth".
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;

    // Above the horizon the gradient tightens towards the zenith; below it the
    // ground bounce fades in fast, because that half is mostly there to feed
    // the environment map rather than to be looked at.
    vec3 up = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), uFalloff));
    vec3 down = mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.55));
    vec3 col = mix(down, up, step(0.0, h));

    // A soft, wide sun bloom plus a much wider ambient wash in the same
    // direction. No disc: a hard sun would be a blown white dot on an iPad.
    float sd = max(dot(dir, normalize(uSunDir)), 0.0);
    col += uSunColor * (pow(sd, uSunSize) * uSunStrength + pow(sd, 3.0) * uSunStrength * 0.16);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb += (hash12(gl_FragCoord.xy) - 0.5) * uDither;
  }
`;

function makeUniforms() {
  return {
    uZenith: { value: new THREE.Color(0x4fb6ff) },
    uHorizon: { value: new THREE.Color(0xcdf0ff) },
    uGround: { value: new THREE.Color(0x6faa55) },
    uSunColor: { value: new THREE.Color(0xfff0cf) },
    uSunDir: { value: new THREE.Vector3(0.45, 0.65, 0.6) },
    uSunSize: { value: 26 },
    uSunStrength: { value: 0.55 },
    uFalloff: { value: 0.7 },
    uDither: { value: 1.1 / 255 },
  };
}

function makeMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

export function createSky(scene) {
  const uniforms = makeUniforms();
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 20);
  const material = makeMaterial(uniforms);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  // Drawn first and never depth-tested against, so it can never occlude the
  // board however close the camera gets to the dome.
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);

  return {
    mesh,
    uniforms,
    // The dome rides with the camera: a fixed dome would show parallax against
    // the board as the camera drifts, which reads as the world sliding.
    follow(camera) {
      mesh.position.copy(camera.position);
      mesh.updateMatrix();
    },
    apply(theme) {
      uniforms.uZenith.value.setHex(theme.zenith);
      uniforms.uHorizon.value.setHex(theme.horizon);
      uniforms.uGround.value.setHex(theme.ground);
      uniforms.uSunColor.value.setHex(theme.sun);
      uniforms.uSunDir.value.fromArray(theme.sunDir).normalize();
      uniforms.uSunStrength.value = theme.sunGlow;
      uniforms.uFalloff.value = theme.skyFalloff;
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Image-based lighting
// ---------------------------------------------------------------------------

// How far the *baked* zenith is pulled towards the horizon colour. Same
// argument as `bounce` below, one hemisphere up: `zenith` is chosen to look
// good as the top of a backdrop, and several themes want it very dark there
// (World 2's is 0x140f2e). But the zenith is precisely what an upward-facing
// surface integrates, so baking the backdrop value handed tile *tops* almost no
// ambient while tile *sides* -- which see the bright horizon band -- got plenty.
// That inverted the read on every step: the side of a stair came out brighter
// than its tread. A real overhead sky is never that much darker than its own
// horizon, so meeting it halfway is both more physical and what makes the
// board's forms legible.
const ENV_ZENITH_LIFT = 0.5;
const _envHorizon = new THREE.Color();

// One PMREM per theme, kept because there are only six of them and rebuilding
// costs a six-face render plus a convolution chain every time the player moves
// between worlds. `dispose()` releases the lot.
export function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cache = new Map(); // theme key -> WebGLRenderTarget
  const envScene = new THREE.Scene();
  const uniforms = makeUniforms();
  const geometry = new THREE.SphereGeometry(1, 32, 20);
  const material = makeMaterial(uniforms);
  material.toneMapped = false; // an env map must stay linear scene-referred
  envScene.add(new THREE.Mesh(geometry, material));

  return {
    // Returns the PMREM texture for a theme, building it on first use.
    get(key, theme) {
      const size = flags().envMapSize;
      const cacheKey = `${key}:${size}`;
      const hit = cache.get(cacheKey);
      if (hit) return hit.texture;
      _envHorizon.setHex(theme.horizon);
      uniforms.uZenith.value.setHex(theme.zenith).lerp(_envHorizon, ENV_ZENITH_LIFT);
      uniforms.uHorizon.value.copy(_envHorizon);
      // `bounce`, not `ground`: the env map wants the colour light picks up
      // off the world below (grass, sand, rock), while the dome the player sees
      // wants deep atmosphere. Baking the visible colour would tint every
      // island's underside with whatever looks best as a backdrop.
      uniforms.uGround.value.setHex(theme.bounce);
      uniforms.uSunColor.value.setHex(theme.sun);
      uniforms.uSunDir.value.fromArray(theme.sunDir).normalize();
      // The env map wants a broader, stronger sun than the visible dome does:
      // it is standing in for every bounce off a sky we cannot ray-trace.
      uniforms.uSunStrength.value = theme.sunGlow * 1.4;
      uniforms.uSunSize.value = 8;
      uniforms.uFalloff.value = theme.skyFalloff;
      uniforms.uDither.value = 0;
      const target = pmrem.fromScene(envScene, 0, 0.1, 10);
      cache.set(cacheKey, target);
      return target.texture;
    },
    dispose() {
      for (const target of cache.values()) target.dispose();
      cache.clear();
      geometry.dispose();
      material.dispose();
      pmrem.dispose();
    },
  };
}
