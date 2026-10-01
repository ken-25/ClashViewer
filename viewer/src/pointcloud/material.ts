import * as THREE from "three";

// 点群のシェーダー。
// 点の大きさの自動調整は Potree（BSD-2-Clause）の ADAPTIVE と同じ考え方で、
// その位置で表示中の最も細かいノードの階層（visibleNodes テクスチャを辿って求める）から大きさを決める。

export enum ColorMode {
  RGB = 0,
  Intensity = 1,
  Height = 2,
  Solid = 3,
}

export enum SizeMode {
  Fixed = 0,
  Adaptive = 1,
}

export const VN_TEX_WIDTH = 2048;

const vertexShader = /* glsl */ `
precision highp float;
precision highp int;
#include <common>
#include <clipping_planes_pars_vertex>

attribute vec4 rgba;
attribute float intensity;

uniform float uSize;
uniform float uMinSize;
uniform float uMaxSize;
uniform int uSizeMode;
uniform float uScreenHeight;
uniform float uOctreeSize;
uniform float uOctreeSpacing;
uniform float uLevel;
uniform float uVNStart;
uniform highp sampler2D uVisibleNodes;

uniform int uColorMode;
uniform vec2 uHeightRange;
uniform vec2 uIntensityRange;
uniform vec3 uSolid;
uniform bool uHasRgb;
uniform bool uHasIntensity;

varying vec3 vColor;

int bitCount(int mask, int index) {
  int n = 0;
  for (int i = 0; i < 8; i++) {
    if (i > index) break;
    if (((mask >> i) & 1) == 1) n++;
  }
  return n;
}

vec4 vnTexel(int i) {
  return texelFetch(uVisibleNodes, ivec2(i % ${VN_TEX_WIDTH}, i / ${VN_TEX_WIDTH}), 0);
}

float getLOD() {
  vec3 offset = vec3(0.0);
  int iOffset = int(uVNStart);
  float depth = uLevel;
  for (int i = 0; i <= 30; i++) {
    float nodeSize = uOctreeSize / pow(2.0, float(i) + uLevel);
    vec3 index3d = floor((position - offset) / nodeSize + 0.5);
    index3d = clamp(index3d, 0.0, 1.0);
    int index = int(round(4.0 * index3d.x + 2.0 * index3d.y + index3d.z));
    vec4 value = vnTexel(iOffset);
    int mask = int(round(value.r * 255.0));
    if (((mask >> index) & 1) == 1) {
      int advance = int(round(value.g * 255.0)) * 256 + int(round(value.b * 255.0)) + bitCount(mask, index - 1);
      iOffset = iOffset + advance;
      depth += 1.0;
    } else {
      return depth;
    }
    offset = offset + vec3(nodeSize * 0.5) * index3d;
  }
  return depth;
}

vec3 ramp(float t) {
  // 青→シアン→緑→黄→赤
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.19, 0.21, 0.58);
  vec3 c1 = vec3(0.16, 0.65, 0.85);
  vec3 c2 = vec3(0.30, 0.78, 0.35);
  vec3 c3 = vec3(0.98, 0.85, 0.20);
  vec3 c4 = vec3(0.86, 0.20, 0.16);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>

  float size = uSize;
  if (uSizeMode == 1) {
    float lod = getLOD();
    float worldSize = uSize * uOctreeSpacing * 1.5 / pow(2.0, lod);
    float proj = isOrthographic
      ? uScreenHeight * 0.5 * projectionMatrix[1][1]
      : uScreenHeight * 0.5 * projectionMatrix[1][1] / max(-mvPosition.z, 1e-4);
    size = worldSize * proj;
  }
  gl_PointSize = clamp(size, uMinSize, uMaxSize);

  if (uColorMode == 0 && uHasRgb) {
    vColor = rgba.rgb;
  } else if (uColorMode == 1 && uHasIntensity) {
    float t = (intensity - uIntensityRange.x) / max(1e-6, uIntensityRange.y - uIntensityRange.x);
    vColor = vec3(clamp(t, 0.0, 1.0));
  } else if (uColorMode == 2 || (uColorMode == 0 && !uHasRgb)) {
    float z = (modelMatrix * vec4(position, 1.0)).z;
    vColor = ramp((z - uHeightRange.x) / max(1e-6, uHeightRange.y - uHeightRange.x));
  } else {
    vColor = uSolid;
  }
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
#include <common>
#include <clipping_planes_pars_fragment>
uniform bool uRound;
uniform float uOpacity;
varying vec3 vColor;
void main() {
  #include <clipping_planes_fragment>
  if (uRound) {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;
  }
  gl_FragColor = vec4(vColor, uOpacity);
}
`;

export class PointCloudMaterial extends THREE.ShaderMaterial {
  readonly visibleNodesTexture: THREE.DataTexture;

  constructor() {
    const data = new Uint8Array(VN_TEX_WIDTH * 4 * 4);
    const tex = new THREE.DataTexture(data, VN_TEX_WIDTH, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    super({
      vertexShader,
      fragmentShader,
      clipping: true,
      transparent: false,
      // glslVersion 未指定: WebGL2 では three.js が "#version 300 es" と互換マクロを付ける（texelFetch・ビット演算が使える）
      uniforms: {
        uSize: { value: 1.0 },
        uMinSize: { value: 1.5 },
        uMaxSize: { value: 40.0 },
        uSizeMode: { value: SizeMode.Adaptive },
        uScreenHeight: { value: 1000 },
        uOctreeSize: { value: 1 },
        uOctreeSpacing: { value: 1 },
        uLevel: { value: 0 },
        uVNStart: { value: 0 },
        uVisibleNodes: { value: tex },
        uColorMode: { value: ColorMode.RGB },
        uHeightRange: { value: new THREE.Vector2(0, 10) },
        uIntensityRange: { value: new THREE.Vector2(0, 1) },
        uSolid: { value: new THREE.Color(0.8, 0.8, 0.8) },
        uHasRgb: { value: true },
        uHasIntensity: { value: true },
        uRound: { value: true },
        uOpacity: { value: 1.0 },
      },
    });
    this.visibleNodesTexture = tex;
  }
}
