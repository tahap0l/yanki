export function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Gölgelendirici derlenemedi: ' + log);
  }
  return s;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string, feedback?: string[]): WebGLProgram {
  const p = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  if (feedback) gl.transformFeedbackVaryings(p, feedback, gl.SEPARATE_ATTRIBS);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('Program bağlanamadı: ' + gl.getProgramInfoLog(p));
  return p;
}

export function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Record<string, WebGLUniformLocation> {
  const out: Record<string, WebGLUniformLocation> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)!;
    const name = info.name.replace(/\[0\]$/, '');
    out[name] = gl.getUniformLocation(p, info.name)!;
  }
  return out;
}

/** Tam ekran üçgen için köşe gölgelendiricisi. */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Ortak GLSL: gürültü, ton eşleme ve titreşim (dither). */
export const GLSL_COMMON = `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm3(vec2 p) { return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + 17.1) + 0.125 * vnoise(p * 4.12 + 31.7); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
// sert beyaz flaşı engelleyen yumuşak ton eşleme (omuz düşük)
vec3 tonemap(vec3 c) { c = c / (1.0 + c * 0.85); return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 dither(vec3 c, vec2 fc) { return c + (hash12(fc) - 0.5) / 255.0; }
`;
