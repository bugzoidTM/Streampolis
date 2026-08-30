/**
 * Final look pass: filmic lift/gamma/gain grade, saturation, a physically
 * plausible vignette, chromatic aberration that only bites at the edges, and
 * animated grain. Runs after tone mapping, so it operates in display space.
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse:    { value: null as unknown },
    uTime:       { value: 0 },
    uLift:       { value: [0.0, 0.0, 0.0] },
    uGamma:      { value: [1.0, 1.0, 1.0] },
    uGain:       { value: [1.0, 1.0, 1.0] },
    uSaturation: { value: 1.06 },
    uContrast:   { value: 1.04 },
    uVignette:   { value: 0.34 },
    uAberration: { value: 0.0016 },
    uGrain:      { value: 0.024 },
    uResolution: { value: [1920, 1080] },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSaturation, uContrast, uVignette, uAberration, uGrain;
    uniform vec3 uLift, uGamma, uGain;
    uniform vec2 uResolution;
    varying vec2 vUv;

    // Hash-based grain: cheap, temporally animated, no texture fetch.
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Lateral chromatic aberration grows with the square of the radius,
      // matching how real lenses fail toward the edge of the frame.
      vec2 offset = centred * uAberration * r2 * 4.0;
      vec3 color;
      color.r = texture2D(tDiffuse, uv + offset).r;
      color.g = texture2D(tDiffuse, uv).g;
      color.b = texture2D(tDiffuse, uv - offset).b;

      // ASC CDL style grade.
      color = clamp(color, 0.0, 1.0);
      color = uLift + color * (uGain - uLift);
      color = pow(max(color, vec3(1e-5)), 1.0 / uGamma);

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);
      color = (color - 0.5) * uContrast + 0.5;

      // Vignette: smooth cos^4 falloff rather than a hard radial ramp.
      float v = 1.0 - uVignette * pow(smoothstep(0.0, 0.85, r2 * 2.0), 1.6);
      color *= v;

      float g = hash(uv * uResolution + fract(uTime) * 137.31) - 0.5;
      // Grain is strongest in the mid-tones, as on real film stock.
      color += g * uGrain * (1.0 - abs(luma * 2.0 - 1.0));

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};
