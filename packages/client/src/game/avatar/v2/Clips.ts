import * as THREE from 'three';

/**
 * As faixas que faltam no pacote.
 *
 * Os 21 personagens trazem 24 animações e nenhuma delas é DANÇAR ou SENTAR —
 * são faixas de jogo de ação: tiro, soco, rolamento, espada. Este é um jogo de
 * live e de vida virtual, onde dançar é o gesto principal e sentar é metade do
 * mobiliário fazer sentido. Então elas são autoradas aqui.
 *
 * O formato é o mesmo que o corpo procedural usava e que funcionou: uma POSE é
 * um punhado de ossos com ângulos em GRAUS, lidos como delta sobre a pose de
 * repouso do esqueleto. Ler como delta é o que permite escrever "o braço sobe
 * 60°" sem saber como o autor do pacote deixou o braço parado.
 *
 * As faixas são compiladas UMA vez por página: os 21 personagens dividem o
 * mesmo esqueleto, então o resultado serve para todo mundo.
 */

/** Ossos do pacote que estas poses usam. O resto fica onde está. */
type Bone =
  | 'Body' | 'Hips' | 'Abdomen' | 'Torso' | 'Chest' | 'Neck' | 'Head'
  | 'Shoulder.L' | 'UpperArm.L' | 'LowerArm.L' | 'Wrist.L'
  | 'Shoulder.R' | 'UpperArm.R' | 'LowerArm.R' | 'Wrist.R'
  | 'UpperLeg.L' | 'LowerLeg.L' | 'Foot.L'
  | 'UpperLeg.R' | 'LowerLeg.R' | 'Foot.R';

type Pose = Partial<Record<Bone, [number, number, number]>>;

/*
 * A convenção deste rig, aprendida com ele mesmo.
 *
 * Escrever "o braço sobe 150° em X" é o que se faria num rig de convenção
 * Unreal, e aqui produz um braço que empurra para a frente e nunca sobe. Em
 * vez de tentar eixos, a resposta veio da faixa `Wave` DO PACOTE: comparando o
 * quadro do aceno com a pose de repouso, o braço direito sobe com **Z ≈ +86°**
 * e o esquerdo com Z negativo. Então Z levanta, X balança para frente e para
 * trás, e Y gira o braço para dentro.
 */

interface Spec {
  name: string;
  duration: number;
  loop: boolean;
  keys: Array<{ time: number; pose: Pose }>;
}

/*
 * Por que NÃO há translação de corpo aqui.
 *
 * A primeira versão baixava o osso `Body` para sentar e o levantava para
 * dançar. O resultado foi um borrão branco atravessando a praça em quatro
 * capturas seguidas: neste rig a altura de pé não está na pose de repouso — o
 * osso fica na origem e é a ANIMAÇÃO do pacote que o levanta, quadro a quadro.
 * Uma faixa nossa de posição não soma a isso, ela SUBSTITUI, e o corpo desaba
 * para a origem enquanto a malha continua amarrada ao bind.
 *
 * Então o movimento vertical vem de onde ele vem num corpo de verdade: dos
 * JOELHOS. E sentar não baixa o avatar — quem o põe na altura do assento é a
 * cena, que já sabe a altura do banco (`routine.y` nos figurantes).
 */

const D = Math.PI / 180;

/**
 * DANÇAR. Peso alternando de um pé para o outro, quadril acompanhando, braços
 * subindo em contratempo e cabeça marcando — o mínimo que lê como dança e não
 * como ginástica. Quatro chaves num ciclo de 1,6 s: dois tempos de música.
 */
const DANCE: Spec = {
  name: 'Dance',
  duration: 1.6,
  loop: true,
  keys: [
    {
      time: 0,
      pose: {
        Hips: [0, 8, -6], Abdomen: [2, -4, 4], Chest: [-2, 6, -3], Head: [4, -6, 2],
        'UpperArm.L': [-14, -10, -104], 'LowerArm.L': [0, -40, 0],
        'UpperArm.R': [-8, 6, 34], 'LowerArm.R': [0, 30, 0],
        'UpperLeg.L': [-10, 0, 3], 'LowerLeg.L': [16, 0, 0],
        'UpperLeg.R': [6, 0, -3], 'LowerLeg.R': [22, 0, 0],
      },
    },
    {
      time: 0.4,
      pose: {
        Hips: [0, 0, 0], Abdomen: [4, 0, 0], Chest: [-4, 0, 0], Head: [-2, 0, 0],
        'UpperArm.L': [-10, -8, -72], 'LowerArm.L': [0, -55, 0],
        'UpperArm.R': [-10, 8, 72], 'LowerArm.R': [0, 55, 0],
        'UpperLeg.L': [-4, 0, 0], 'LowerLeg.L': [8, 0, 0],
        'UpperLeg.R': [-4, 0, 0], 'LowerLeg.R': [8, 0, 0],
      },
    },
    {
      time: 0.8,
      pose: {
        Hips: [0, -8, 6], Abdomen: [2, 4, -4], Chest: [-2, -6, 3], Head: [4, 6, -2],
        'UpperArm.L': [-8, -6, -34], 'LowerArm.L': [0, -30, 0],
        'UpperArm.R': [-14, 10, 104], 'LowerArm.R': [0, 40, 0],
        'UpperLeg.L': [6, 0, 3], 'LowerLeg.L': [22, 0, 0],
        'UpperLeg.R': [-10, 0, -3], 'LowerLeg.R': [16, 0, 0],
      },
    },
    {
      time: 1.2,
      pose: {
        Hips: [0, 0, 0], Abdomen: [4, 0, 0], Chest: [-4, 0, 0], Head: [-2, 0, 0],
        'UpperArm.L': [-10, -8, -72], 'LowerArm.L': [0, -55, 0],
        'UpperArm.R': [-10, 8, 72], 'LowerArm.R': [0, 55, 0],
      },
    },
  ],
};

/**
 * SENTAR. Coxa à frente, canela para baixo, tronco levemente inclinado e o
 * corpo BAIXADO — sem baixar, o avatar senta no ar meio metro acima do banco,
 * que é o erro clássico de uma pose de sentar sem deslocamento de raiz.
 */
const SIT: Spec = {
  name: 'Sit',
  duration: 3.2,
  loop: true,
  keys: [
    {
      time: 0,
      pose: {
        Abdomen: [6, 0, 0], Chest: [4, 0, 0], Head: [-4, 0, 0],
        'UpperLeg.L': [-86, 3, 0], 'LowerLeg.L': [78, 0, 0], 'Foot.L': [10, 0, 0],
        'UpperLeg.R': [-86, -3, 0], 'LowerLeg.R': [78, 0, 0], 'Foot.R': [10, 0, 0],
        'UpperArm.L': [-14, -6, -12], 'LowerArm.L': [0, -34, 0],
        'UpperArm.R': [-14, 6, 12], 'LowerArm.R': [0, 34, 0],
      },
    },
    {
      time: 1.6,
      pose: {
        // Respiração: o tronco sobe dois graus e volta. Uma pose de sentar
        // absolutamente imóvel lê como manequim de vitrine.
        Abdomen: [4, 0, 0], Chest: [6, 0, 0], Head: [-3, 0, 0],
        'UpperLeg.L': [-86, 3, 0], 'LowerLeg.L': [78, 0, 0], 'Foot.L': [10, 0, 0],
        'UpperLeg.R': [-86, -3, 0], 'LowerLeg.R': [78, 0, 0], 'Foot.R': [10, 0, 0],
        'UpperArm.L': [-12, -6, -12], 'LowerArm.L': [0, -30, 0],
        'UpperArm.R': [-12, 6, 12], 'LowerArm.R': [0, 30, 0],
      },
    },
  ],
};

/** COMEMORAR: os dois braços para cima, tronco aberto, cabeça erguida. */
const CELEBRATE: Spec = {
  name: 'Celebrate',
  duration: 1.4,
  loop: true,
  keys: [
    {
      time: 0,
      pose: {
        Chest: [-8, 0, 0], Head: [-10, 0, 0],
        'UpperArm.L': [-6, 0, -142], 'LowerArm.L': [0, -18, 0],
        'UpperArm.R': [-6, 0, 142], 'LowerArm.R': [0, 18, 0],
      },
    },
    {
      time: 0.7,
      pose: {
        Chest: [-4, 0, 0], Head: [-6, 0, 0],
        'UpperArm.L': [-10, 0, -126], 'LowerArm.L': [0, -34, 0],
        'UpperArm.R': [-10, 0, 126], 'LowerArm.R': [0, 34, 0],
      },
    },
  ],
};

/** BATER PALMA: mãos à frente, encostando e afastando. */
const CLAP: Spec = {
  name: 'Clap',
  duration: 0.6,
  loop: true,
  keys: [
    {
      time: 0,
      pose: {
        Chest: [4, 0, 0], Head: [-2, 0, 0],
        'UpperArm.L': [-26, -22, -62], 'LowerArm.L': [0, -78, 0],
        'UpperArm.R': [-26, 22, 62], 'LowerArm.R': [0, 78, 0],
      },
    },
    {
      time: 0.3,
      pose: {
        Chest: [2, 0, 0], Head: [0, 0, 0],
        'UpperArm.L': [-22, -30, -58], 'LowerArm.L': [0, -96, 0],
        'UpperArm.R': [-22, 30, 58], 'LowerArm.R': [0, 96, 0],
      },
    },
  ],
};

const SPECS = [DANCE, SIT, CELEBRATE, CLAP];

let compiled: THREE.AnimationClip[] | null = null;

/**
 * Compila as faixas contra o esqueleto de um personagem já carregado.
 *
 * Precisa de um exemplar porque as poses são DELTAS: sem a rotação de repouso
 * de cada osso não dá para dizer "sobe 60°". Como os 21 personagens dividem o
 * mesmo esqueleto, o resultado é compilado uma vez e servido a todos.
 */
export function extraClips(rig: THREE.Object3D): THREE.AnimationClip[] {
  if (compiled) return compiled;

  const rest = new Map<string, THREE.Quaternion>();
  rig.traverse((o) => {
    if ((o as THREE.Bone).isBone) rest.set(o.name, o.quaternion.clone());
  });
  if (!rest.size) return [];

  const euler = new THREE.Euler();
  const delta = new THREE.Quaternion();
  const out: THREE.AnimationClip[] = [];

  for (const spec of SPECS) {
    const tracks: THREE.KeyframeTrack[] = [];
    const bones = new Set<Bone>();
    for (const key of spec.keys) for (const b of Object.keys(key.pose) as Bone[]) bones.add(b);

    for (const bone of bones) {
      // O nome do osso é procurado SANEADO: o `GLTFLoader` remove os pontos ao
      // importar, então o `UpperArm.L` do arquivo vira `UpperArmL` na cena.
      // Procurar pelo nome do arquivo devolve `undefined` e a pose perde
      // silenciosamente todos os ossos de braço e perna — sobra a coluna, e o
      // resultado não parece um erro, parece uma animação ruim.
      const target = THREE.PropertyBinding.sanitizeNodeName(bone);
      const base = rest.get(target);
      if (!base) continue;
      const times: number[] = [];
      const values: number[] = [];
      for (const key of spec.keys) {
        const angles = key.pose[bone] ?? [0, 0, 0];
        euler.set(angles[0] * D, angles[1] * D, angles[2] * D);
        delta.setFromEuler(euler);
        const q = base.clone().multiply(delta);
        times.push(key.time);
        values.push(q.x, q.y, q.z, q.w);
      }
      // Fecha o ciclo: a última chave repete a primeira no fim da duração,
      // senão o laço dá um salto na virada.
      if (spec.loop) {
        times.push(spec.duration);
        values.push(values[0], values[1], values[2], values[3]);
      }
      // O ponto também é SEPARADOR na gramática de nome de faixa do three
      // (`nó.propriedade`), então saneá-lo resolve as duas pontas de uma vez.
      tracks.push(new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, times, values));
    }

    out.push(new THREE.AnimationClip(spec.name, spec.duration, tracks));
  }

  compiled = out;
  return out;
}
