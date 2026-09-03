import * as THREE from 'three';
import { INTERIORS, PORTALS, portalNear, type Portal, type SceneId } from '@streampolis/shared';
import { makeCameraTransparent } from './CameraManager.js';

/**
 * As portas, desenhadas.
 *
 * Um portal precisa ser visto de longe (senão ninguém descobre que existe),
 * não pode parecer um objeto sólido (senão as pessoas tentam desviar dele) e
 * não pode custar caro (são três ou quatro por cena, e a praça já é o lugar
 * mais pesado do jogo). Por isso: um anel no chão, um pilar de luz baixo e uma
 * placa — três malhas por porta, todas sem sombra.
 *
 * A câmera ATRAVESSA tudo isto. Um marcador tratado como obstáculo encurta o
 * braço da câmera quando o jogador passa perto e a cena vira um close
 * involuntário — o mesmo defeito que os refletores da live já tinham causado.
 */

const CALM = 0x6f7cff;
const HOT = 0xff5fa2;

/**
 * O raio para o qual o marcador foi desenhado.
 *
 * O anel e o pilar têm tamanho fixo, e isso era invisível enquanto todas as
 * portas eram da praça. Numa sala pequena o mesmo marcador vira um disco rosa
 * de quase três metros no meio do quarto e um pilar que atravessa o teto —
 * exatamente o que o apartamento mostrava. Agora o corpo do marcador é
 * ESCALADO pelo raio da porta, e a altura pelo pé-direito.
 */
const RAIO_BASE = 2.4;

function label(text: string): THREE.Sprite {
  const FONT = 34;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 ${FONT}px system-ui, sans-serif`;
  const w = measure.measureText(text).width;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w + 44);
  canvas.height = Math.ceil(FONT * 1.9);
  const c = canvas.getContext('2d')!;
  c.font = `700 ${FONT}px system-ui, sans-serif`;
  c.textBaseline = 'middle';
  c.fillStyle = 'rgba(10, 12, 20, 0.72)';
  c.beginPath();
  c.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2);
  c.fill();
  c.fillStyle = '#eef1f8';
  c.fillText(text, 22, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false,
  }));
  // Grande e alta de propósito: a praça tem 44 m de ponta a ponta e uma placa
  // de tamanho de placa de nome vira um pixel rosa atrás de uma árvore. Se não
  // dá para ler do outro lado da praça, a porta não existe para quem chegou
  // agora — que é justamente quem precisa dela.
  const h = 0.62;
  sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
  sprite.position.y = 3.1;
  sprite.renderOrder = 9;
  return sprite;
}

interface Marker {
  portal: Portal;
  group: THREE.Group;
  ring: THREE.Mesh;
  beam: THREE.Mesh;
}

export class Portals {
  private readonly markers: Marker[] = [];
  private readonly group = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private clock = 0;

  constructor(scene: THREE.Scene, private readonly sceneId: SceneId) {
    // Pé-direito da sala, quando é uma sala. Ao ar livre não há teto e o pilar
    // pode ter a altura inteira.
    const teto = INTERIORS[sceneId]?.shell.height ?? Infinity;
    const altura = Math.min(1, (teto - 0.15) / 3.6);

    const ringGeo = new THREE.RingGeometry(1.05, 1.35, 40);
    // Cone alto e aberto em cima: é a parte que se vê por cima dos bancos e
    // entre as árvores. O anel no chão só aparece de perto.
    const beamGeo = new THREE.CylinderGeometry(1.45, 1.20, 3.6, 24, 1, true);
    this.disposables.push(ringGeo, beamGeo);

    for (const portal of PORTALS[sceneId] ?? []) {
      const largura = portal.r / RAIO_BASE;
      const ringMat = new THREE.MeshBasicMaterial({
        color: CALM, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false,
      });
      const beamMat = new THREE.MeshBasicMaterial({
        color: CALM, transparent: true, opacity: 0.16, side: THREE.BackSide, depthWrite: false,
      });
      this.disposables.push(ringMat, beamMat);

      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;

      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.y = 1.8;

      // O corpo do marcador é um grupo à parte da PLACA: escalar tudo junto
      // encolheria o texto, que é medido em metros e existe para ser lido de
      // longe.
      const corpo = new THREE.Group();
      corpo.add(ring, beam);
      corpo.scale.set(largura, altura, largura);

      const placa = label(portal.label);
      placa.position.y = Math.min(placa.position.y, teto - 0.5);

      const g = new THREE.Group();
      g.position.set(portal.x, 0, portal.z);
      g.rotation.y = portal.ry;
      g.add(corpo, placa);
      makeCameraTransparent(g);
      this.group.add(g);
      this.markers.push({ portal, group: g, ring, beam });
    }

    scene.add(this.group);
  }

  /** A porta ao alcance de um ponto, e o brilho de quem está perto. */
  update(dt: number, x: number, z: number): Portal | null {
    this.clock += dt;
    const near = portalNear(this.sceneId, x, z);
    // Respiração lenta: um anel estático some no chão de pedra, e um anel
    // piscando forte lê como alerta de erro.
    const pulse = 0.62 + Math.sin(this.clock * 1.6) * 0.12;

    for (const m of this.markers) {
      const active = near?.id === m.portal.id;
      const ring = m.ring.material as THREE.MeshBasicMaterial;
      const beam = m.beam.material as THREE.MeshBasicMaterial;
      ring.color.setHex(active ? HOT : CALM);
      beam.color.setHex(active ? HOT : CALM);
      ring.opacity = active ? 0.95 : pulse;
      beam.opacity = active ? 0.30 : 0.15;
      m.group.scale.setScalar(active ? 1.06 : 1);
    }
    return near;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const sprite = o as THREE.Sprite;
      if (sprite.isSprite) {
        const mat = sprite.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
    });
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
