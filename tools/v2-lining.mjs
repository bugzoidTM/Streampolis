#!/usr/bin/env node
/**
 * O portão do FORRO: **o corpo por baixo não pode aparecer por cima da roupa.**
 *
 * O forro é a peça que o avatar veste sozinho, tingida com o tom de pele, para
 * tapar o vão entre duas peças que não se encontram — a saia da bruxa com um
 * tênis baixo, a blusa feminina com a calça masculina. `gate:wardrobe` prova
 * que o vão fica tapado. Este prova o PREÇO: o forro é uma peça de roupa
 * fazendo as vezes de corpo, e duas roupas de formatos diferentes sobre as
 * mesmas pernas se atravessam. Quando ele vence o teste de profundidade dentro
 * da silhueta do traje, o avatar ganha manchas cor de pele no meio da calça —
 * defeito pior do que o buraco que o forro veio consertar, porque aparece em
 * TODO visual misturado e não só nos poucos que tinham vão.
 *
 * Mede duas coisas de propósito, porque cada uma sozinha aprova o defeito
 * oposto:
 *
 *   vazamento — forro por cima do traje. Apertar o forro faz cair.
 *   fresta    — buraco FECHADO na silhueta encostado no forro: apertar
 *               demais encolhe o forro para longe da bainha e abre um vão
 *               por onde se vê a praça através da perna. Apertar faz SUBIR.
 *
 * E fotografa **de perto e enquadrado na emenda**, uma passada por vão, o que
 * é a parte que mais custou a aprender: um avatar de 1,8 m num quadro de
 * 400 px dá quatro pixels a um estilhaço de três centímetros e dilui o defeito
 * em sessenta mil pixels de silhueta. Enquadrada na figura, esta mesma conta
 * deu 0 de 30 em vazamento e 0 de 30 em fresta para um forro que em close
 * estava EXPLODIDO, com lascas atravessando a canela e um cone saindo da
 * cintura. As faixas vêm de `AvatarV2.liningBands()` e não da caixa envolvente
 * do forro.
 *
 * **A lupa mente se a conta for ingênua**, e três correções foram precisas para
 * o número querer dizer alguma coisa. Todas nasceram do mesmo engano: chamar de
 * defeito todo pixel em que o forro vence o teste de profundidade dentro da
 * silhueta.
 *
 *   1. Isso conta OCLUSÃO LEGÍTIMA — a perna esquerda passa à frente da bota
 *      direita, a coxa passa à frente do avesso de uma saia rodada. Num close
 *      de meio metro é enorme: 26% num visual que a olho nu está correto. A
 *      passada virou uma régua de DISTÂNCIA, e só conta o que está à frente do
 *      pano por menos de `PROXIMO`.
 *   2. Com dupla face, olhar para dentro do cano de uma bota registra a parede
 *      de trás dela. Passada de face frontal, como o jogo desenha.
 *   3. **Pele sobre pele não é defeito.** Dezessete calçados do acervo trazem
 *      o tornozelo junto e os `top` trazem os braços, e `tint` pinta esses
 *      primitivos com o mesmo tom de pele do forro. Era o maior lote de
 *      acusações que restava — 35 mil pixels num só visual — e o que se via na
 *      tela era uma cor sobre a mesma cor.
 *
 * Os 30 visuais são misturas que ninguém montaria por acaso — passos primos
 * sobre as quatro listas, para cruzar rigs, comprimentos e alturas de cano.
 * Um conjunto inteiro não carrega forro nenhum (as quatro peças do mesmo
 * personagem foram desenhadas uma para a outra) e por isso não é medido aqui.
 *
 *   npm run gate:lining
 *   N=8 node tools/v2-lining.mjs      (mais rápido, para iterar)
 *
 * Precisa do Vite de pé em 127.0.0.1:5273.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { readdirSync } from 'node:fs';

const dir = 'packages/client/public/assets/wardrobe';
const ids = readdirSync(dir).filter(f => f.endsWith('.glb') && !f.startsWith('under') && !f.startsWith('animations')).map(f => f.replace('.glb',''));
const bySlot = { head: [], top: [], bottom: [], shoes: [] };
for (const id of ids) for (const s of Object.keys(bySlot)) if (id.endsWith('_'+s)) bySlot[s].push(id);
for (const s of Object.keys(bySlot)) bySlot[s].sort();

const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 380, height: 560 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('http://127.0.0.1:5273/?view=lab&count=0&spin=0&yaw=0&tier=high', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForFunction(() => window.__ready === true, { timeout: 60000 });

/**
 * Decodifica uma passada: **distância à câmera, em metros, por pixel.**
 *
 * O laboratório desenha a superfície mais próxima com os dois canais altos
 * carregando a distância em 16 bits e o azul marcando "aqui tem superfície".
 * O fundo não é desenhado e fica em zero, que é como se sabe onde não há nada.
 *
 * Era uma máscara branca e preta, e a máscara media o defeito errado: ela
 * chama de vazamento todo pixel em que o forro vence o traje, e num close de
 * meio metro isso inclui a perna esquerda passando à frente da bota direita e
 * a perna inteira à frente do avesso de uma saia rodada. Nos dois casos o
 * forro está na frente, nos dois casos está certo.
 */
const raw = async (dataUrl, escala) => {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const dist = new Float32Array(n);
  // Zero é fundo; qualquer outro valor é a malha que ficou na frente, contada
  // a partir de 1 na ordem de `pecas`.
  const tem = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    tem[i] = data[i * 3 + 2];
    dist[i] = tem[i] ? ((data[i * 3] * 255 + data[i * 3 + 1]) / 65025) * escala : Infinity;
  }
  return { dist, tem, w: info.width, h: info.height };
};

/**
 * Buracos FECHADOS na silhueta: pixels de fundo que o avatar rodeia por todos
 * os lados. É por eles que se vê a praça através da perna.
 *
 * Precisa existir porque a conta de vazamento aprovava o defeito oposto. Ela
 * mede a mancha de pele por cima do traje, e apertar o forro faz a mancha
 * sumir — apertando o bastante ele encolhe para LONGE da bainha e abre uma
 * fresta entre a peça e a perna, que a conta de vazamento pontua como
 * melhora. Os dois números juntos é que dizem alguma coisa.
 */
function frestas(data, w, h, forro) {
  const fundo = new Uint8Array(w * h);
  const fila = [];
  for (let x = 0; x < w; x++) { fila.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { fila.push(y * w, y * w + w - 1); }
  for (const i of fila) if (data[i] <= 40 && !fundo[i]) fundo[i] = 1;
  const pilha = fila.filter((i) => fundo[i]);
  while (pilha.length) {
    const i = pilha.pop();
    const x = i % w; const y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (fundo[j] || data[j] > 40) continue;
      fundo[j] = 1; pilha.push(j);
    }
  }
  // Só as frestas ENCOSTADAS NO FORRO. Um avatar de braços soltos fecha um
  // triângulo de fundo na axila, e ele conta como buraco em toda combinação —
  // um piso de 1% que não mexe com nada do que se está medindo. O buraco que
  // interessa é o que se abre na emenda quando o forro encolhe para longe da
  // bainha, e esse tem forro do outro lado.
  const R = 3;
  let dentro = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 40 || fundo[i]) continue;
    const x = i % w; const y = (i / w) | 0;
    let perto = false;
    for (let dy = -R; dy <= R && !perto; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (forro[ny * w + nx]) { perto = true; break; }
      }
    }
    if (perto) dentro++;
  }
  return dentro;
}

/**
 * A que distância, à frente do traje, o forro deixa de ser defeito.
 *
 * Interpenetração é o forro furando a roupa por milímetros — a peça e a que
 * está por baixo dela ocupam o mesmo lugar. Oclusão é o forro estar à frente
 * do traje por muito mais do que a espessura de um pano: a perna esquerda na
 * frente da bota direita, ou a coxa na frente da saia da outra perna. As duas
 * coisas são "forro vencendo o teste de profundidade dentro da silhueta"; só a
 * primeira é defeito.
 *
 * Um centímetro e meio, e não cinco, porque a distribuição das distâncias diz
 * onde fica a fronteira: no pior visual medido, as acusações se juntavam em
 * dois montes bem separados — um abaixo de um centímetro, que é roupa
 * atravessando roupa, e outro entre dois e cinco, que era a perna à frente da
 * parede de trás da bota. O segundo saiu de vez com a passada de face frontal;
 * o limiar apertado é o que garante que nada daquele tamanho volte a entrar.
 */
const PROXIMO = 0.015;

async function medir(look, yaw = 0, pose = ['idle', 0]) {
  const r = await p.evaluate(
    ([l, y, a, f]) => window.__lab.liningExposure(l, y, false, a, f),
    [look, yaw, pose[0], pose[1]],
  );
  if (!r.temForro || !r.quadros.length) {
    return { forro: false, vazamento: 0, tapado: 0, silhueta: 0, fresta: 0, oclusao: 0, pele: 0 };
  }
  let vaz = 0, tap = 0, sil = 0, fre = 0, ocl = 0, pel = 0;
  for (const q of r.quadros) {
    const m = await umQuadro(q, r.escala, r.pele);
    vaz += m.vazamento; tap += m.tapado; sil += m.silhueta;
    fre += m.fresta; ocl += m.oclusao; pel += m.pele;
  }
  return { forro: true, vazamento: vaz, tapado: tap, silhueta: sil, fresta: fre, oclusao: ocl, pele: pel };
}

async function umQuadro(q, escala, ehPele) {
  const T = await raw(q.traje, escala);
  const F = await raw(q.forro, escala);
  let vaz = 0, tap = 0, sil = 0, ocl = 0, pel = 0;
  const vestido = new Uint8Array(T.tem.length);
  const soForro = new Uint8Array(T.tem.length);
  for (let i = 0; i < T.tem.length; i++) {
    const t = T.tem[i]; const f = F.tem[i];
    if (t) sil++;
    if (t || f) vestido[i] = 255;
    if (!f) continue;
    soForro[i] = 1;
    if (!t) { tap++; continue; }
    // O forro atrás do traje é o caso normal: está vestido por baixo.
    if (F.dist[i] >= T.dist[i]) continue;
    // Longe demais para ser interpenetração: é a outra perna, ou o avesso.
    if (T.dist[i] - F.dist[i] > PROXIMO) { ocl++; continue; }
    // PELE SOBRE PELE não é defeito. Dezessete calçados deste acervo trazem o
    // tornozelo junto, e os `top` trazem os braços; `tint` pinta esses
    // primitivos com o mesmo tom de pele que o forro recebe. Quando o forro
    // atravessa um deles, o que aparece na tela é a mesma cor sobre a mesma
    // cor — não há o que ver, e contar isso como defeito foi o que manteve
    // treze de trinta visuais reprovados com a figura impecável na foto. Era
    // o maior lote de acusações do pior caso: 35 mil pixels contra o toco de
    // perna do sapato.
    if (ehPele[t - 1]) { pel++; continue; }
    vaz++;
  }
  return { vazamento: vaz, tapado: tap, silhueta: sil, oclusao: ocl, pele: pel,
           fresta: frestas(vestido, T.w, T.h, soForro) };
}

/**
 * Os limiares, em porcentagem do traje NO QUADRO DA EMENDA — não da figura.
 *
 * O quadro é um close: a faixa da emenda mais um palmo, o que dá meio milímetro
 * por pixel. É uma lupa de dez aumentos sobre a costura, e é de propósito — a
 * versão que fotografava a figura inteira aprovou com zero um forro que estava
 * explodido em lascas. Mas o número que sai dela não é o que o jogador vê, e o
 * critério tem de dizer qual é qual.
 *
 * São DOIS, porque duas coisas diferentes estragam o avatar:
 *
 *   MEDIA  — vazamento espalhado por todo o acervo. Um modelo de aperto errado
 *            (fração fixa, eixo chutado, folga sem direção) aparece aqui antes
 *            de aparecer em qualquer caso isolado.
 *   PIOR   — um visual inteiro estragado, mesmo com o resto impecável. A loja
 *            vende as peças separadas; o cliente que comprou justo aquela
 *            combinação não se consola com a média.
 *
 * Onde estão hoje: média 0,39% e pior caso 2,55%, com quatro dos trinta acima
 * de um por cento. Os quatro são de CINTURA, e todos pela mesma razão — a
 * bainha de uma calça é inclinada e nenhuma medida por faixa de altura a
 * acompanha, de modo que sobra sempre uma nesga de forro sob a peça de cima.
 * Em close ela se vê; no enquadramento em que o jogo desenha o avatar, meio
 * milímetro por pixel viram cinco, e ela deixa de existir. Os limites ficam
 * logo acima do medido: apertados o bastante para que qualquer regressão do
 * modelo de aperto reprove, folgados o bastante para não reprovarem o que está
 * no ar.
 */
const LIMIAR_MEDIA = 0.6;
const LIMIAR_PIOR = 3.0;
const LIMIAR_VAZ = 1.0;
const LIMIAR_FRESTA = 0.5;

/**
 * De onde se olha, e em que pose.
 *
 * Três giros porque a emenda vaza de um lado e não do outro. E um passo de
 * CAMINHADA porque o forro é recortado e apertado uma vez só, na pose em que o
 * avatar nasce: a margem que o enfia por baixo da peça vizinha existe para o
 * que acontece depois, quando a perna dobra e a bainha sobe. Sem essa vista,
 * encurtar a margem sempre parece melhoria — o vazamento cai e a fresta não
 * aparece, porque parado nada se move.
 */
const VISTAS = [
  [0, ['idle', 0]],
  [Math.PI / 2, ['idle', 0]],
  [Math.PI, ['idle', 0]],
  [0.9, ['walk', 0.35]],
  [2.6, ['walk', 0.7]],
];

const N = Number(process.env.N ?? 30);
const passos = [1, 5, 9, 13];
const linhas = [];
for (let i = 0; i < N; i++) {
  const look = {
    hair: bySlot.head[(i * passos[0]) % bySlot.head.length],
    top: bySlot.top[(i * passos[1] + 3) % bySlot.top.length],
    bottom: bySlot.bottom[(i * passos[2] + 7) % bySlot.bottom.length],
    shoes: bySlot.shoes[(i * passos[3] + 11) % bySlot.shoes.length],
  };
  let vaz = 0, tap = 0, sil = 0, fre = 0, ocl = 0, pel = 0;
  for (const [yaw, pose] of VISTAS) {
    const m = await medir(look, yaw, pose);
    vaz += m.vazamento; tap += m.tapado; sil += m.silhueta;
    fre += m.fresta; ocl += m.oclusao; pel += m.pele;
  }
  const pct = sil ? (100 * vaz / sil) : 0;
  const pctF = sil ? (100 * fre / sil) : 0;
  linhas.push({ i, look, vaz, tap, sil, fre, ocl, pel, pct: +pct.toFixed(2), pctF: +pctF.toFixed(2) });
  console.log(String(i).padStart(3), `vazamento ${pct.toFixed(2)}%  fresta ${pctF.toFixed(2)}%  tapado ${String(tap).padStart(5)} px  pele ${String(pel).padStart(5)} px  ${look.top} / ${look.bottom}`);
}
linhas.sort((a, c) => (c.pct + c.pctF) - (a.pct + a.pctF));
console.log('\n--- PIORES ---');
for (const l of linhas.slice(0, 5)) console.log(`  vaz ${l.pct}%  fresta ${l.pctF}%  ${JSON.stringify(l.look)}`);
const total = linhas.reduce((a, l) => a + l.pct, 0) / linhas.length;
const totalF = linhas.reduce((a, l) => a + l.pctF, 0) / linhas.length;
const tapado = linhas.reduce((a, l) => a + l.tap, 0);
console.log(`\nvazamento médio ${total.toFixed(2)}%; fresta média ${totalF.toFixed(2)}%; acima do limiar: vaz ${linhas.filter(l => l.pct > LIMIAR_VAZ).length}/${linhas.length}, fresta ${linhas.filter(l => l.pctF > LIMIAR_FRESTA).length}/${linhas.length}; cobertura ${tapado} px`);

const pior = Math.max(...linhas.map((l) => l.pct));
const piorF = Math.max(...linhas.map((l) => l.pctF));
const queixas = [];
if (total > LIMIAR_MEDIA) queixas.push(`vazamento médio ${total.toFixed(2)}% > ${LIMIAR_MEDIA}%`);
if (pior > LIMIAR_PIOR) queixas.push(`pior vazamento ${pior.toFixed(2)}% > ${LIMIAR_PIOR}%`);
if (piorF > LIMIAR_FRESTA) queixas.push(`pior fresta ${piorF.toFixed(2)}% > ${LIMIAR_FRESTA}%`);
await b.close();
if (queixas.length) {
  console.error(`\nREPROVADO: ${queixas.join('; ')}.`);
  process.exit(1);
}
console.log(`\nAPROVADO: média ${total.toFixed(2)}% (limite ${LIMIAR_MEDIA}%), pior ${pior.toFixed(2)}% (limite ${LIMIAR_PIOR}%), pior fresta ${piorF.toFixed(2)}%.`);
