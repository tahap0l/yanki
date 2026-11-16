import type { Quality, SceneFrame, SceneRenderer } from '../types';
import { paletteAt } from '../palettes';
import { FULLSCREEN_VS, GLSL_COMMON, program, uniforms } from './gl';

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;
uniform float uTime, uFlow, uCurl, uFlicker, uGain, uHeight, uHush, uLayers;
uniform vec3 uSkyTop, uSkyLow, uA, uB, uC;
${GLSL_COMMON}
float ridge(float x) { return 0.16 + 0.10 * fbm3(vec2(x * 1.6, 3.7)) + 0.05 * vnoise(vec2(x * 5.0, 9.1)); }
void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  vec3 col = mix(uSkyLow, uSkyTop, smoothstep(0.1, 0.95, p.y));
  // yıldızlar
  vec2 g = p * vec2(140.0);
  vec2 id = floor(g);
  float r = hash12(id);
  if (r > 0.986) col += vec3(0.85, 0.9, 1.0) * smoothstep(0.13, 0.0, length(fract(g) - 0.5)) * (0.55 + 0.45 * sin(uTime * (0.7 + 3.0 * r) + r * 30.0)) * 0.35;
  vec3 aur = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    if (fi >= uLayers) break;
    float x = p.x * (0.85 + 0.18 * fi) + fi * 2.3;
    // melodi kıvrımı: düşük frekanslı bükülme + kıvrım genliği
    float bendLow = fbm3(vec2(x * 0.55 + uFlow * 0.05, fi * 4.1 + uFlow * 0.03)) - 0.5;
    float fold = sin(x * (2.2 + 1.4 * uCurl) + uFlow * (0.18 + 0.05 * fi) + vnoise(vec2(x * 1.3, uFlow * 0.07 + fi)) * 3.0);
    float base = 0.52 + 0.09 * fi + bendLow * (0.22 + 0.28 * uCurl) + fold * 0.035 * (0.5 + uCurl);
    float dy = p.y - base;
    if (dy < -0.03) continue;
    float h = uHeight * (0.85 + 0.25 * fi);
    // perdenin yer yer kopması
    float presence = smoothstep(0.18, 0.52, vnoise(vec2(x * 0.5 + uFlow * 0.02, fi * 7.0 + 1.0)));
    // keskin parlak alt kenar + yukarı uzanan sönümlü ışınlar
    float lower = smoothstep(-0.008, 0.004, dy);
    float prof = lower * (exp(-max(dy, 0.0) / h) * 0.75 + exp(-max(dy, 0.0) / (h * 0.12)) * 0.9);
    prof += exp(-abs(dy) / 0.012) * 0.25;
    // dikey ışınlar: x boyunca ince doku, tizler titreşimi hızlandırır
    float rx = x * 22.0 + uFlow * 0.25 * (1.0 + uFlicker);
    float rays = 0.35 + 0.65 * fbm3(vec2(rx, 0.37 * fi + dy * 0.35));
    rays *= 0.75 + 0.25 * vnoise(vec2(x * 90.0 + uFlow * 0.6 * (0.5 + uFlicker), dy * 0.3 + fi));
    rays = mix(rays, rays * rays * 1.5, 0.3 + 0.4 * uFlicker);
    vec3 c = mix(uA, uC, smoothstep(0.0, h * 1.6, dy));
    c = mix(c, uB, 0.2 + 0.2 * sin(fi * 1.7 + x * 0.6));
    prof *= presence;
    aur += c * prof * rays * (0.75 - 0.15 * fi);
  }
  col += aur * uGain * 0.85;
  // dağ silueti ve gölde hafif yansıma
  if (p.y < 0.34) {
    float rid = ridge(p.x);
    float mtn = smoothstep(rid + 0.004, rid - 0.004, p.y);
    vec3 ground = uSkyLow * 0.08;
    col = mix(col, ground + aur * 0.05, mtn);
  }
  float vig = smoothstep(1.4, 0.3, length((vUv - vec2(0.5, 0.55)) * vec2(1.2, 1.0)));
  col *= mix(0.6, 1.0, vig) * (1.0 - 0.3 * uHush);
  o = vec4(dither(tonemap(col), gl_FragCoord.xy), 1.0);
}`;

export class AuroraGL implements SceneRenderer {
  readonly id = 'aurora' as const;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation>;
  private vao: WebGLVertexArrayObject;
  private w = 1; private h = 1;
  private flow = 0;
  private curl = 0.4;
  private flicker = 0.3;
  private gain = 0.8;

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = program(gl, FULLSCREEN_VS, FS);
    this.u = uniforms(gl, this.prog);
    this.vao = gl.createVertexArray()!;
  }

  resize(w: number, h: number): void { this.w = w; this.h = h; }

  render(f: SceneFrame, q: Quality): void {
    const gl = this.gl;
    const k = (tau: number) => 1 - Math.exp(-f.dt / tau);
    const rm = f.reducedMotion ? 0.35 : 1;
    // akış hızı: enerji ve tizlerle
    this.flow += f.dt * rm * (0.6 + 1.4 * f.energy + 0.8 * f.treble);
    // melodi ve orta bant şeritleri kıvırır
    const targetCurl = Math.min(1.2, 0.15 + 0.7 * f.mid + 0.6 * Math.max(0, f.melody - 0.25)) * f.intensity;
    this.curl += (targetCurl - this.curl) * k(0.9);
    this.flicker += (f.treble * (f.reducedMotion ? 0.3 : 1) - this.flicker) * k(0.3);
    const targetGain = (0.55 + 0.55 * f.energy + 0.18 * f.beatPulse * f.sync + 0.12 * f.barPulse * f.sync) * (0.5 + 0.5 * f.intensity);
    this.gain += (Math.min(1.25, targetGain) - this.gain) * k(0.12);
    const pal = paletteAt(f.paletteFrom, f.paletteTo, f.paletteMix);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uRes, this.w, this.h);
    gl.uniform1f(this.u.uTime, f.time);
    gl.uniform1f(this.u.uFlow, this.flow);
    gl.uniform1f(this.u.uCurl, this.curl);
    gl.uniform1f(this.u.uFlicker, this.flicker);
    gl.uniform1f(this.u.uGain, this.gain);
    gl.uniform1f(this.u.uHeight, 0.16 + 0.12 * f.sectionEnergy + 0.03 * f.barPulse * f.sync);
    gl.uniform1f(this.u.uHush, f.hush);
    gl.uniform1f(this.u.uLayers, q.level >= 3 ? 2 : 3);
    gl.uniform3fv(this.u.uSkyTop, pal.skyTop);
    gl.uniform3fv(this.u.uSkyLow, pal.skyLow);
    gl.uniform3fv(this.u.uA, pal.a);
    gl.uniform3fv(this.u.uB, pal.b);
    gl.uniform3fv(this.u.uC, pal.c);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog);
    this.gl.deleteVertexArray(this.vao);
  }
}
