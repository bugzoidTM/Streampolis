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
    /** Quanto da imagem vai a preto e branco. 0 desliga o passe inteiro. */
    uNoir:       { value: 0.0 },
    /** O matiz que SOBREVIVE ao preto e branco, em voltas (0 = vermelho). */
    uKeepHue:    { value: 0.0 },
    /** Meia-largura da janela de matiz preservada, em voltas. */
    uKeepWidth:  { value: 0.055 },
    /** Ganho de saturação do que sobreviveu: o pouco que fica precisa gritar. */
    uKeepBoost:  { value: 1.0 },
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
    uniform float uNoir, uKeepHue, uKeepWidth, uKeepBoost;
    uniform vec3 uLift, uGamma, uGain;
    uniform vec2 uResolution;
    varying vec2 vUv;

    /**
     * Matiz e saturação de uma cor, sem passar por HSV inteiro.
     *
     * Só estes dois números interessam ao passe noir: o matiz diz SE a cor
     * pertence à janela preservada, e a saturação diz o quanto ela é uma cor de
     * verdade. Sem o segundo, uma parede de tijolo levemente avermelhada
     * atravessa o filtro junto com o néon — e Sin City não é uma foto com as
     * paredes coloridas, é um preto e branco com UMA coisa vermelha nele.
     */
    vec2 hueSat(vec3 c) {
      float mx = max(c.r, max(c.g, c.b));
      float mn = min(c.r, min(c.g, c.b));
      float d = mx - mn;
      if (d < 1e-5) return vec2(0.0, 0.0);
      float h;
      if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
      else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
      else                h = (c.r - c.g) / d + 4.0;
      return vec2(h / 6.0, d / max(mx, 1e-5));
    }

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

      /**
       * Cor seletiva: preto e branco com uma faixa de matiz sobrevivente.
       *
       * Vem DEPOIS da saturação e do contraste de propósito. Antes deles, o
       * contraste do noir (que é alto) esticaria o cinza e a cor guardada ao
       * mesmo tempo, e o vermelho preservado sairia rosa estourado.
       *
       * A distância de matiz é circular — vermelho está em 0,0 e também em
       * 1,0, e uma subtração reta acharia que são opostos.
       */
      if (uNoir > 0.0) {
        vec2 hs = hueSat(clamp(color, 0.0, 1.0));
        float dh = abs(hs.x - uKeepHue);
        dh = min(dh, 1.0 - dh);
        float keep = 1.0 - smoothstep(uKeepWidth, uKeepWidth * 2.0, dh);
        /**
         * O critério de saturação, e por que ele é tão alto.
         *
         * Com o corte em 0,14 a fachada de tijolo passava: um reboco quente
         * tem saturação ~0,2 e matiz a 24°, que cabia na janela. O resultado
         * era uma PAREDE de vinte metros vermelha no meio do preto e branco —
         * o oposto de um acento, e o defeito mais visível da primeira versão
         * desta cena. Néon e fogo têm saturação acima de 0,6; parede pintada,
         * não. É esse vão que o corte precisa cair dentro.
         */
        keep *= smoothstep(0.42, 0.64, hs.y);
        float mono = dot(color, vec3(0.2126, 0.7152, 0.0722));
        vec3 saturado = mix(vec3(mono), color, uKeepBoost);
        color = mix(mix(vec3(mono), saturado, keep), color, 1.0 - uNoir);
      }

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
