import * as THREE from 'three';
import { makeCameraTransparent } from './CameraManager.js';

/**
 * A parada da vez de um bico, desenhada no mundo.
 *
 * Um pilar de luz e um anel no chão — o vocabulário que qualquer jogo de rua
 * usa para dizer "vá até aqui", e o mesmo dos portais (`game/Portals.ts`), de
 * propósito: duas linguagens diferentes para "este é o seu destino" fariam o
 * jogador aprender duas vezes.
 *
 * ## Por que é AMARELO
 *
 * Porque o Distrito Sombra preserva o vermelho e mais nada (ver `LOOK_NOIR`).
 * Um marcador vermelho se dissolveria no meio dos letreiros — que é onde ele
 * mais precisa aparecer —, e um azul sairia cinza. O amarelo é o único acento
 * que o filtro deixa passar como cinza CLARO, e cinza claro sobre uma rua
 * escura é a coisa mais legível que existe aqui.
 *
 * ## Um objeto só, movido
 *
 * A rota tem paradas em sequência, mas só uma é a da vez. Criar e destruir um
 * marcador por parada seria alocar geometria no meio da corrida; este é criado
 * uma vez, escondido com `visible` e movido de lugar.
 */

const COR = 0xffd24a;

export class GigMarker {
  private readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private clock = 0;

  constructor(scene: THREE.Scene) {
    const ringGeo = new THREE.RingGeometry(1.0, 1.3, 40);
    // Alto: numa avenida com fachadas de onze andares, um pilar de 3,6 m some
    // atrás do primeiro poste. Este precisa ser visto do outro extremo da rua.
    const beamGeo = new THREE.CylinderGeometry(1.15, 0.95, 7.0, 24, 1, true);
    this.disposables.push(ringGeo, beamGeo);

    /**
     * ADITIVO, ao contrário do marcador de porta.
     *
     * A porta é vista à luz do dia, na praça; este é visto de madrugada,
     * debaixo de chuva e atrás de um passe de preto e branco que apaga a cor
     * dele. Misturado por transparência normal, o pilar sai como um cinza a
     * mais no meio de dez postes cinza. Somado à luz, ele passa do limiar do
     * bloom (`LOOK_NOIR.bloomThreshold`) e vira a coisa mais clara do quadro —
     * que é exatamente o que um destino precisa ser.
     */
    const ringMat = new THREE.MeshBasicMaterial({
      color: COR, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const beamMat = new THREE.MeshBasicMaterial({
      color: COR, transparent: true, opacity: 0.3, side: THREE.BackSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.disposables.push(ringMat, beamMat);

    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;

    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.position.y = 3.5;

    this.group.add(this.ring, this.beam);
    this.group.visible = false;
    // A câmera atravessa: um marcador tratado como obstáculo encurta o braço
    // da câmera e vira um close involuntário toda vez que se chega na parada —
    // que é exatamente o momento em que ver a rua importa.
    makeCameraTransparent(this.group);
    scene.add(this.group);
  }

  /** Onde é a parada da vez. `null` apaga o marcador. */
  setTarget(target: { x: number; z: number } | null): void {
    if (!target) { this.group.visible = false; return; }
    this.group.position.set(target.x, 0, target.z);
    this.group.visible = true;
  }

  /**
   * Respiração e ACENDIMENTO na chegada.
   *
   * O pilar fica mais forte quando o jogador entra no raio. Não é enfeite: sem
   * isso, chegar na parada não tem confirmação nenhuma na tela até a resposta
   * do servidor voltar, e um jogador que não vê resposta anda mais um pouco
   * achando que ainda não chegou.
   */
  update(dt: number, x: number, z: number): void {
    if (!this.group.visible) return;
    this.clock += dt;
    const d = Math.hypot(x - this.group.position.x, z - this.group.position.z);
    const perto = d <= 2.6;
    const pulse = 0.68 + Math.sin(this.clock * 2.1) * 0.16;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = perto ? 1 : pulse;
    (this.beam.material as THREE.MeshBasicMaterial).opacity = perto ? 0.52 : 0.24 + (pulse - 0.68) * 0.2;
    this.group.scale.setScalar(perto ? 1.1 : 1);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
