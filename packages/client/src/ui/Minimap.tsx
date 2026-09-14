import { useEffect, useRef } from 'react';
import { SCENE_AREA, SCENE_COLLIDERS } from '@streampolis/shared';
import { useMinimapStore } from '../state/useMinimapStore.js';
import './minimap.css';

/**
 * Minimapa da CENA ATUAL: o jogador, as portas, o alvo da interação, o amigo
 * que se veio encontrar, a parada do bico e — quando um personagem está
 * levando o jogador a algum lugar — o guia e o destino. Norte para cima; a
 * área da cena (disco da praça, retângulo do bairro ou do interior) é o
 * quadro. Não é mapa mundial: fora desta cena não há nada para desenhar.
 *
 * Canvas e `requestAnimationFrame` lendo a store, sem estado React por
 * quadro: o World escreve a 10 Hz e o desenho custa uma dúzia de traços.
 */
const SIZE = 156;

export function Minimap({ hidden }: { hidden?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (hidden) return;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = useMinimapStore.getState();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      if (!s.sceneId || !s.player) return;
      const area = SCENE_AREA[s.sceneId];
      // Enquadramento: a área inteira da cena cabe no quadro, com 8 px de margem.
      const cx = area?.x ?? 0;
      const cz = area?.z ?? 0;
      const halfW = area ? (area.kind === 'circle' ? area.r : area.hw) : 40;
      const halfD = area ? (area.kind === 'circle' ? area.r : area.hd) : 40;
      const scale = (SIZE / 2 - 8) / Math.max(halfW, halfD);
      const px = (x: number) => SIZE / 2 + (x - cx) * scale;
      const pz = (z: number) => SIZE / 2 + (z - cz) * scale;

      // O chão.
      ctx.fillStyle = 'rgba(22, 22, 34, 0.72)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (!area || area.kind === 'circle') ctx.arc(px(cx), pz(cz), halfW * scale, 0, Math.PI * 2);
      else ctx.rect(px(cx - halfW), pz(cz - halfD), halfW * 2 * scale, halfD * 2 * scale);
      ctx.fill();
      ctx.stroke();

      // Obstáculos maiores (prédios, balcões, bancos): dão forma ao lugar sem virar planta.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      for (const c of SCENE_COLLIDERS[s.sceneId] ?? []) {
        if (c.kind === 'circle') {
          if (c.r < 0.5) continue;
          ctx.beginPath(); ctx.arc(px(c.x), pz(c.z), Math.max(1, c.r * scale), 0, Math.PI * 2); ctx.fill();
        } else {
          if (c.hw * c.hd < 0.4) continue;
          ctx.save();
          ctx.translate(px(c.x), pz(c.z));
          ctx.rotate(-c.ry);
          ctx.fillRect(-c.hw * scale, -c.hd * scale, c.hw * 2 * scale, c.hd * 2 * scale);
          ctx.restore();
        }
      }

      // Portas.
      for (const p of s.portals) {
        const active = s.target?.id === `portal:${p.id}`;
        ctx.fillStyle = active ? '#ffd25a' : 'rgba(124, 92, 255, 0.95)';
        ctx.beginPath(); ctx.rect(px(p.x) - 3, pz(p.z) - 3, 6, 6); ctx.fill();
      }
      // A parada do bico.
      if (s.gig) {
        ctx.fillStyle = '#ffc23c';
        ctx.beginPath();
        ctx.moveTo(px(s.gig.x), pz(s.gig.z) - 5); ctx.lineTo(px(s.gig.x) + 5, pz(s.gig.z));
        ctx.lineTo(px(s.gig.x), pz(s.gig.z) + 5); ctx.lineTo(px(s.gig.x) - 5, pz(s.gig.z));
        ctx.closePath(); ctx.fill();
      }
      // O guia e o destino dele.
      if (s.guide) {
        ctx.strokeStyle = 'rgba(178, 150, 255, 0.9)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(px(s.guide.npc.x), pz(s.guide.npc.z)); ctx.lineTo(px(s.guide.dest.x), pz(s.guide.dest.z)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = '#b296ff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(px(s.guide.dest.x) - 4, pz(s.guide.dest.z) - 4); ctx.lineTo(px(s.guide.dest.x) + 4, pz(s.guide.dest.z) + 4);
        ctx.moveTo(px(s.guide.dest.x) + 4, pz(s.guide.dest.z) - 4); ctx.lineTo(px(s.guide.dest.x) - 4, pz(s.guide.dest.z) + 4); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = '#b296ff';
        ctx.beginPath(); ctx.arc(px(s.guide.npc.x), pz(s.guide.npc.z), 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(178, 150, 255, 0.7)';
        ctx.beginPath(); ctx.arc(px(s.guide.npc.x), pz(s.guide.npc.z), 6.5, 0, Math.PI * 2); ctx.stroke();
      }
      // O amigo marcado.
      if (s.friend) {
        ctx.fillStyle = '#39d98a';
        ctx.beginPath(); ctx.arc(px(s.friend.x), pz(s.friend.z), 3.5, 0, Math.PI * 2); ctx.fill();
      }
      // O alvo da interação, quando é um personagem (a porta já acende acima).
      if (s.target && !s.target.id.startsWith('portal:')) {
        ctx.strokeStyle = '#ffd25a';
        ctx.beginPath(); ctx.arc(px(s.target.x), pz(s.target.z), 5, 0, Math.PI * 2); ctx.stroke();
      }
      // O jogador: um triângulo apontando para onde ele está virado.
      const yaw = s.player.yaw;
      const ax = px(s.player.x);
      const az = pz(s.player.z);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(ax + fx * 6, az + fz * 6);
      ctx.lineTo(ax - fx * 4 + fz * 4, az - fz * 4 - fx * 4);
      ctx.lineTo(ax - fx * 4 - fz * 4, az - fz * 4 + fx * 4);
      ctx.closePath(); ctx.fill();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [hidden]);

  if (hidden) return null;
  return <canvas ref={ref} className="minimap" style={{ width: SIZE, height: SIZE }} aria-label="Minimapa da cena" />;
}
