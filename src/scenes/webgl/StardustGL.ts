import type { Quality, SceneFrame, SceneRenderer } from '../types';
import { paletteAt } from '../palettes';
import { FlowDirector } from '../flow';
import { FULLSCREEN_VS, GLSL_COMMON, program, uniforms } from './gl';

const BOX = { zNear: 0.9 };

const UPDATE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPos;  // u, v (ekran-normalize), z (derinlik), yaşam
layout(location=1) in vec4 aVel;  // dünya hızı xyz, tohum
out vec4 vPos;
out vec4 vVel;
uniform float uDt, uTime, uDepth, uTurb, uFlowStr;
uniform vec3 uFlow;
vec3 field(vec3 p, float t) {
  return vec3(
    sin(p.y * 1.7 + t * 0.31) + sin(p.z * 1.1 - t * 0.17),
    sin(p.z * 1.5 - t * 0.23) + sin(p.x * 1.3 + t * 0.13),
    sin(p.x * 1.9 + t * 0.27) + sin(p.y * 0.9 - t * 0.21)) * 0.5;
}
void main() {
  vec3 p = aPos.xyz, v = aVel.xyz;
  float seed = aVel.w;
  float d = max(0.3, 1.6 - p.z);
  vec3 wp = vec3(p.xy * d, p.z);
  vec3 target = uFlow * uFlowStr * (0.55 + 0.9 * seed) + field(wp * 0.8, uTime) * uTurb;
  v += (target - v) * min(1.0, uDt * (1.0 + 1.5 * seed));
  // perspektif türevi: uzaktakiler yavaş (paralaks), yaklaşanlar dışa açılır
  p.xy += (v.xy + p.xy * v.z) / d * uDt;
  p.z += v.z * uDt;
  p.xy = -1.15 + mod(p.xy + 1.15, 2.3);
  float span = uDepth + ${BOX.zNear.toFixed(2)};
  p.z = -uDepth + mod(p.z + uDepth, span);
  vPos = vec4(p, fract(aPos.w + uDt * 0.03 * (0.5 + seed)));
  vVel = vec4(v, seed);
}`;
const NOOP_FS = `#version 300 es
precision mediump float; out vec4 o; void main() { o = vec4(0.0); }`;

const DRAW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPos;
layout(location=1) in vec4 aVel;
uniform float uAspect, uFocal, uSize, uPulse, uDepth, uAlpha;
uniform vec3 uA, uB, uC;
out vec3 vCol;
out float vA;
void main() {
  float d = max(0.3, 1.6 - aPos.z);
  gl_Position = vec4(aPos.x * uFocal, aPos.y * uFocal, 0.0, 1.0);
  float seed = aVel.w;
  float big = pow(seed, 6.0);
  float size = uSize * (0.55 + 0.9 * seed + 4.0 * big) * (1.0 + 0.35 * uPulse) / d;
  gl_PointSize = clamp(size, 1.0, 40.0);
  float speed = length(aVel.xyz);
  vCol = mix(mix(uA, uB, fract(seed * 7.13)), uC, clamp(speed * 0.6 - 0.1, 0.0, 1.0) * 0.6 + big * 0.5);
  // kenarda ve derinlik uçlarında sönümle (sarma geçişi görünmesin)
  float edge = smoothstep(1.15, 1.0, abs(aPos.x)) * smoothstep(1.15, 1.0, abs(aPos.y));
  float depthFade = smoothstep(-uDepth, -uDepth + 1.2, aPos.z) * smoothstep(${BOX.zNear.toFixed(2)}, 0.3, aPos.z);
  float tw = 0.7 + 0.3 * sin(aPos.w * 6.2831 * 3.0);
  vA = uAlpha * edge * depthFade * tw * (1.0 + 2.0 * big) * clamp(2.0 / size, 0.2, 1.0) * (0.5 + 0.5 / d);
}`;
const DRAW_FS = `#version 300 es
precision mediump float;
in vec3 vCol; in float vA;
out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = exp(-d * 3.5) * vA;
  o = vec4(vCol * a, a);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime, uHush, uExposure;
uniform vec3 uSkyTop, uSkyLow, uB;
${GLSL_COMMON}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  vec3 bg = mix(uSkyLow * 0.6, uSkyTop, smoothstep(-0.6, 0.6, p.y + 0.15 * sin(p.x * 1.3)));
  float neb = fbm(p * 1.4 + vec2(uTime * 0.01, -uTime * 0.006));
  bg += uB * pow(neb, 3.0) * 0.08;
  vec3 parts = texture(uTex, vUv).rgb * uExposure;
  vec3 col = bg + parts;
  float vig = smoothstep(1.3, 0.25, length(p));
  col *= mix(0.55, 1.0, vig) * (1.0 - 0.3 * uHush);
  o = vec4(dither(tonemap(col), gl_FragCoord.xy), 1.0);
}`;

const FADE_FS = `#version 300 es
precision mediump float; out vec4 o; void main() { o = vec4(0.0); }`;

export class StardustGL implements SceneRenderer {
  readonly id = 'stardust' as const;
  private upd: WebGLProgram; private draw: WebGLProgram; private comp: WebGLProgram; private fade: WebGLProgram;
  private uU: Record<string, WebGLUniformLocation>; private uD: Record<string, WebGLUniformLocation>; private uC: Record<string, WebGLUniformLocation>;
  private bufs: { pos: WebGLBuffer; vel: WebGLBuffer; vao: WebGLVertexArrayObject }[] = [];
  private tf: WebGLTransformFeedback;
  private cur = 0;
  private fsVao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer | null = null;
  private tex: WebGLTexture | null = null;
  private w = 1; private h = 1;
  private flow = new FlowDirector();
  private depth = 5;
  private density = 0.6;
  readonly maxCount: number;

  constructor(private gl: WebGL2RenderingContext, mobile: boolean) {
    this.maxCount = mobile ? 35000 : 80000;
    this.upd = program(gl, UPDATE_VS, NOOP_FS, ['vPos', 'vVel']);
    this.draw = program(gl, DRAW_VS, DRAW_FS);
    this.comp = program(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.fade = program(gl, FULLSCREEN_VS, FADE_FS);
    this.uU = uniforms(gl, this.upd); this.uD = uniforms(gl, this.draw); this.uC = uniforms(gl, this.comp);
    this.fsVao = gl.createVertexArray()!;
    this.tf = gl.createTransformFeedback()!;
    const n = this.maxCount;
    const pos = new Float32Array(n * 4), vel = new Float32Array(n * 4);
    let s = 12345;
    const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < n; i++) {
      pos[i * 4] = (r() * 2 - 1) * 1.15; pos[i * 4 + 1] = (r() * 2 - 1) * 1.15; pos[i * 4 + 2] = -r() * 10 + BOX.zNear * 0.5; pos[i * 4 + 3] = r();
      vel[i * 4 + 3] = r();
    }
    // tohumları karıştır: ilk k parçacık her zaman temsili bir alt küme olsun
    for (let k = 0; k < 2; k++) {
      const pb = gl.createBuffer()!, vb = gl.createBuffer()!, vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, pb);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_COPY);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, vel, gl.DYNAMIC_COPY);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      this.bufs.push({ pos: pb, vel: vb, vao });
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private makeTarget(): void {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const half = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.w, this.h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && half) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h && this.fbo) return;
    this.w = w; this.h = h;
    this.makeTarget();
  }

  render(f: SceneFrame, q: Quality): void {
    const gl = this.gl;
    if (!this.fbo) this.makeTarget();
    this.flow.update(f);
    const k = (tau: number) => 1 - Math.exp(-f.dt / tau);
    // enerji: derinlik ve yoğunluk
    this.depth += (3 + 8 * f.energy + 2 * f.sectionEnergy - this.depth) * k(1.8);
    this.density += (0.3 + 0.7 * Math.min(1, f.energy * 1.1 + 0.15 * f.sectionEnergy) - this.density) * k(1.2);
    const count = Math.max(2000, Math.floor(this.maxCount * q.particles * this.density));
    const src = this.bufs[this.cur], dst = this.bufs[1 - this.cur];

    // 1) güncelleme (dönüşüm geri beslemesi) — yalnız etkin parçacıklar
    gl.useProgram(this.upd);
    gl.uniform1f(this.uU.uDt, Math.min(0.05, f.dt));
    gl.uniform1f(this.uU.uTime, f.time);
    gl.uniform1f(this.uU.uDepth, this.depth);
    gl.uniform1f(this.uU.uTurb, (0.12 + 0.25 * f.mid) * (f.reducedMotion ? 0.4 : 1));
    gl.uniform1f(this.uU.uFlowStr, this.flow.strength);
    gl.uniform3fv(this.uU.uFlow, this.flow.dir);
    gl.bindVertexArray(src.vao);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, dst.pos);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, dst.vel);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    this.cur = 1 - this.cur;

    // 2) iz arabelleğini söndür, parçacıkları ekle
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND);
    // kare hızından bağımsız iz süresi
    const trail = Math.pow(f.reducedMotion ? 0.5 : 0.62 + 0.12 * f.energy, Math.min(4, f.dt * 60));
    gl.blendColor(0, 0, 0, trail);
    gl.blendFunc(gl.ZERO, gl.CONSTANT_ALPHA);
    gl.useProgram(this.fade);
    gl.bindVertexArray(this.fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendFunc(gl.ONE, gl.ONE);
    const pal = paletteAt(f.paletteFrom, f.paletteTo, f.paletteMix);
    gl.useProgram(this.draw);
    const dpr = this.h / 900;
    gl.uniform1f(this.uD.uAspect, this.w / this.h);
    gl.uniform1f(this.uD.uFocal, 1.0 + 0.06 * f.energy);
    gl.uniform1f(this.uD.uSize, 5.2 * Math.max(0.6, dpr) / Math.pow(Math.max(0.3, q.particles), 0.25));
    gl.uniform1f(this.uD.uPulse, (f.beatPulse * 0.6 + f.barPulse * 0.4) * f.sync * f.intensity);
    gl.uniform1f(this.uD.uDepth, this.depth);
    gl.uniform1f(this.uD.uAlpha, (0.2 + 0.14 * f.energy) * (0.55 + 0.45 * f.intensity) * Math.min(2.2, 1 / Math.sqrt(q.particles * this.density + 0.05)) * 0.55);
    gl.uniform3fv(this.uD.uA, pal.a); gl.uniform3fv(this.uD.uB, pal.b); gl.uniform3fv(this.uD.uC, pal.c);
    gl.bindVertexArray(this.bufs[this.cur].vao);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // 3) birleştir + ton eşleme
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.comp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uC.uTex, 0);
    gl.uniform2f(this.uC.uRes, this.w, this.h);
    gl.uniform1f(this.uC.uTime, f.time);
    gl.uniform1f(this.uC.uHush, f.hush);
    gl.uniform1f(this.uC.uExposure, (1 - trail) * 2.2);
    gl.uniform3fv(this.uC.uSkyTop, pal.skyTop); gl.uniform3fv(this.uC.uSkyLow, pal.skyLow); gl.uniform3fv(this.uC.uB, pal.b);
    gl.bindVertexArray(this.fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of this.bufs) { gl.deleteBuffer(b.pos); gl.deleteBuffer(b.vel); gl.deleteVertexArray(b.vao); }
    gl.deleteTransformFeedback(this.tf);
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    for (const p of [this.upd, this.draw, this.comp, this.fade]) gl.deleteProgram(p);
    gl.deleteVertexArray(this.fsVao);
  }
}
