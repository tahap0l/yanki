import type { Quality, SceneFrame, SceneRenderer } from '../types';
import { paletteAt } from '../palettes';
import { FULLSCREEN_VS, GLSL_COMMON, program, uniforms } from './gl';
import { RippleField } from '../ripples';

const MAX_RIPPLES = 16;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;
uniform float uTime, uTreble, uGlow, uHush, uIntensity, uEnergy;
uniform vec4 uRip[${MAX_RIPPLES}];
uniform int uCount;
uniform vec3 uSkyTop, uSkyLow, uTint;
${GLSL_COMMON}
const vec3 MOON = normalize(vec3(0.32, 0.25, 1.0));
vec3 sky(vec3 d, bool stars) {
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uSkyLow, uSkyTop, smoothstep(0.0, 0.55, h));
  float m = dot(d, MOON);
  vec3 moonCol = vec3(1.0, 0.96, 0.88);
  c += moonCol * smoothstep(0.99935, 0.99965, m) * 1.6;
  c += moonCol * (pow(max(m, 0.0), 900.0) * 0.35 + pow(max(m, 0.0), 60.0) * 0.07 * uGlow + pow(max(m, 0.0), 8.0) * 0.025) ;
  c += uTint * pow(max(m, 0.0), 14.0) * 0.04;
  if (stars && d.y > 0.02) {
    vec2 g = d.xy / (d.z + 1.0) * 220.0;
    vec2 id = floor(g);
    float r = hash12(id);
    if (r > 0.985) {
      vec2 f = fract(g) - 0.5;
      float tw = 0.65 + 0.35 * sin(uTime * (1.0 + 4.0 * r) + r * 40.0);
      c += vec3(0.9, 0.95, 1.0) * smoothstep(0.12, 0.0, length(f)) * tw * smoothstep(0.02, 0.25, d.y) * 0.5;
    }
  }
  return c;
}
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uRes.x / uRes.y, 1.0);
  vec3 dir = normalize(vec3(p.x, p.y - 0.18, 1.7));
  vec3 col;
  if (dir.y >= 0.0) {
    col = sky(dir, true);
  } else {
    float camY = 1.0;
    float t = camY / -dir.y;
    vec2 xz = dir.xz * t;
    float detail = 1.0 / (1.0 + t * 0.12);
    // sakin taban dalgaları
    vec2 g = vec2(0.0);
    g += 0.028 * cos(dot(xz, vec2(0.9, 0.4)) * 1.3 + uTime * 0.55) * vec2(0.9, 0.4) * 1.3;
    g += 0.010 * cos(dot(xz, vec2(-0.2, 0.98)) * 6.3 + uTime * 1.7) * vec2(-0.2, 0.98) * 6.3;
    g += 0.006 * cos(dot(xz, vec2(0.7, 0.7)) * 9.1 - uTime * 2.1) * vec2(0.7, 0.7) * 9.1;
    g += 0.014 * cos(dot(xz, vec2(-0.5, 0.8)) * 2.1 + uTime * 0.8) * vec2(-0.5, 0.8) * 2.1;
    g += 0.008 * cos(dot(xz, vec2(0.2, -1.0)) * 3.7 + uTime * 1.1) * vec2(0.2, -1.0) * 3.7;
    // bas vuruşlarından genişleyen halkalar
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      if (i >= uCount) break;
      vec4 r = uRip[i];
      float age = uTime - r.z;
      if (age < 0.0 || age > 7.0) continue;
      vec2 d = xz - r.xy;
      float dist = length(d) + 1e-4;
      float R = age * 1.05;
      float w = 0.30 + age * 0.22;
      float x = dist - R;
      float env = r.w * smoothstep(0.0, 0.35, age) * exp(-age * 0.5) * exp(-x * x / (w * w)) / (1.0 + dist * 0.35);
      float k = 7.5;
      g += env * k * cos(x * k) * (d / dist);
    }
    // ince sesler: yansıma titremesi
    float sh = 0.05 * uTreble * uIntensity * detail;
    vec2 q = xz * 6.0 + vec2(uTime * 0.9, -uTime * 0.6);
    float n0 = vnoise(q), nx = vnoise(q + vec2(0.07, 0.0)), nz = vnoise(q + vec2(0.0, 0.07));
    g += sh * vec2(nx - n0, nz - n0) / 0.07 * 0.12;
    g *= detail;
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 rd = reflect(dir, n);
    rd.y = abs(rd.y);
    vec3 refl = sky(rd, false);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(-dir, n), 0.0), 5.0);
    vec3 deep = uSkyLow * 0.12 + uTint * 0.01;
    col = mix(deep, refl, clamp(fres, 0.0, 1.0));
    // ay yolu pırıltısı
    float spec = pow(max(dot(rd, MOON), 0.0), 380.0);
    col += vec3(1.0, 0.95, 0.85) * spec * (1.2 + 1.5 * uTreble * uIntensity) * detail;
    // ufuk sisi
    col = mix(uSkyLow * 0.85, col, exp(-t * 0.028));
  }
  float vig = smoothstep(1.6, 0.4, length(p * vec2(0.8, 1.0)));
  col *= mix(0.65, 1.0, vig) * (1.0 - 0.25 * uHush);
  o = vec4(dither(tonemap(col), gl_FragCoord.xy), 1.0);
}`;

export class MoonlightGL implements SceneRenderer {
  readonly id = 'moonlight' as const;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation>;
  private vao: WebGLVertexArrayObject;
  private ripples = new RippleField(MAX_RIPPLES);
  private ripData = new Float32Array(MAX_RIPPLES * 4);
  private w = 1; private h = 1;

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = program(gl, FULLSCREEN_VS, FS);
    this.u = uniforms(gl, this.prog);
    this.vao = gl.createVertexArray()!;
  }

  resize(w: number, h: number): void { this.w = w; this.h = h; }

  render(f: SceneFrame, _q: Quality): void {
    const gl = this.gl;
    this.ripples.update(f);
    const n = this.ripples.pack(this.ripData);
    const pal = paletteAt(f.paletteFrom, f.paletteTo, f.paletteMix);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uRes, this.w, this.h);
    gl.uniform1f(this.u.uTime, f.time);
    gl.uniform1f(this.u.uTreble, f.treble * (f.reducedMotion ? 0.4 : 1));
    gl.uniform1f(this.u.uGlow, 1 + 0.6 * f.beatPulse * f.sync * f.intensity + 0.4 * f.energy);
    gl.uniform1f(this.u.uHush, f.hush);
    gl.uniform1f(this.u.uIntensity, f.intensity);
    gl.uniform1f(this.u.uEnergy, f.energy);
    gl.uniform4fv(this.u.uRip, this.ripData);
    gl.uniform1i(this.u.uCount, n);
    gl.uniform3fv(this.u.uSkyTop, pal.skyTop);
    gl.uniform3fv(this.u.uSkyLow, pal.skyLow);
    gl.uniform3fv(this.u.uTint, pal.b);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog);
    this.gl.deleteVertexArray(this.vao);
  }
}
