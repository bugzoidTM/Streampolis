import * as THREE from 'three';

/**
 * O balão de fala sobre a cabeça de quem falou.
 *
 * O chat do mundo já existia no servidor e no painel; o que faltava era a fala
 * acontecer NO MUNDO. Sem isto a praça é um lugar onde as pessoas conversam
 * olhando para uma caixa de texto no canto, e não dá para saber quem disse o
 * quê sem ler o nome — que é o oposto de uma cidade viva.
 *
 * Feito como sprite de canvas, pelo mesmo motivo da placa de nome: uma camada
 * de DOM exigiria uma projeção por quadro por jogador, e geometria de texto
 * custaria uma chamada de desenho por balão. Aqui é uma textura, e ela morre
 * junto com o balão — ao contrário da placa de nome, o texto de um balão nunca
 * se repete, então cachear seria só vazar memória.
 */

const FONT_PX = 30;
const PAD_X = 22;
const PAD_Y = 16;
const LINE = FONT_PX * 1.28;
/** Largura máxima do balão em caracteres, antes de quebrar linha. */
const WRAP_PX = 420;
const MAX_LINES = 4;

/** Quanto tempo o balão fica: leitura, e depois some. */
const HOLD_MS = 4200;
const FADE_MS = 700;

function wrap(ctx: CanvasRenderingContext2D, text: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= WRAP_PX || !line) line = candidate;
    else { lines.push(line); line = word; }
    if (lines.length === MAX_LINES) break;
  }
  if (lines.length < MAX_LINES && line) lines.push(line);
  // Uma fala longa demais é CORTADA aqui e não no servidor: o servidor já tem
  // o limite dele (SPECs §31), e este é o limite do desenho.
  if (lines.length === MAX_LINES) {
    const last = lines[MAX_LINES - 1];
    if (ctx.measureText(last).width > WRAP_PX) lines[MAX_LINES - 1] = `${last.slice(0, -1)}…`;
  }
  return lines;
}

function draw(text: string): THREE.CanvasTexture {
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `500 ${FONT_PX}px system-ui, sans-serif`;
  const lines = wrap(measure, text);
  const width = Math.max(...lines.map((l) => measure.measureText(l).width));

  const canvas = document.createElement('canvas');
  // Espaço extra em baixo para o bico do balão, que é o que amarra a fala a
  // uma cabeça em vez de deixá-la pairando.
  const tail = 18;
  canvas.width = Math.ceil(width + PAD_X * 2);
  canvas.height = Math.ceil(lines.length * LINE + PAD_Y * 2 + tail);

  const c = canvas.getContext('2d')!;
  c.font = `500 ${FONT_PX}px system-ui, sans-serif`;
  c.textBaseline = 'middle';

  const boxH = canvas.height - tail;
  c.fillStyle = 'rgba(12, 14, 22, 0.82)';
  c.beginPath();
  c.roundRect(0, 0, canvas.width, boxH, 18);
  c.moveTo(canvas.width * 0.5 - 14, boxH - 1);
  c.lineTo(canvas.width * 0.5, canvas.height);
  c.lineTo(canvas.width * 0.5 + 14, boxH - 1);
  c.closePath();
  c.fill();

  c.fillStyle = '#f2f5fb';
  lines.forEach((l, i) => c.fillText(l, PAD_X, PAD_Y + LINE * (i + 0.5)));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export class SpeechBubble {
  readonly sprite: THREE.Sprite;
  private age = 0;
  private readonly texture: THREE.CanvasTexture;

  constructor(text: string, private readonly headHeight: number) {
    this.texture = draw(text);
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // Mesma decisão da placa de nome: um poste na frente do jogador não pode
      // cortar a fala dele ao meio.
      depthTest: false,
    }));
    this.sprite.renderOrder = 11;
    const image = this.texture.image as HTMLCanvasElement;
    // Altura no MUNDO por linha de texto. A placa de nome cabe em 16 cm porque
    // tem uma palavra; um balão com a mesma altura total espreme quatro linhas
    // no mesmo espaço e não se lê a três metros — que é a distância em que as
    // pessoas conversam numa praça.
    const h = 0.105 * (image.height / FONT_PX);
    this.sprite.scale.set(h * (image.width / image.height), h, 1);
    this.sprite.center.set(0.5, 0);
  }

  /** Altura do balão acima do chão do avatar. Segue a placa de nome. */
  place(y: number): void {
    this.sprite.position.y = y + this.headHeight;
  }

  /** Avança e diz se ainda está vivo. */
  update(dt: number): boolean {
    this.age += dt * 1000;
    const material = this.sprite.material as THREE.SpriteMaterial;
    material.opacity = this.age <= HOLD_MS
      ? 1
      : Math.max(0, 1 - (this.age - HOLD_MS) / FADE_MS);
    return this.age < HOLD_MS + FADE_MS;
  }

  dispose(): void {
    this.sprite.removeFromParent();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
    this.texture.dispose();
  }
}
