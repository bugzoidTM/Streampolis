# Pés, pelve, olhar e preparação de LOD

O V2 conserva as peças de produção. `ProceduralPose` captura a pose do mixer, aplica correções visuais e restaura essa captura antes do próximo quadro. Nomes, ordem, parentes, matrizes de bind e atributos de skin dos arquivos originais permanecem intactos.

## Rig real e FootIK

A inspeção dos GLBs masculino e feminino encontrou uma particularidade relevante: `UpperLeg.L/R` são filhos de `Body`; `Foot.L/R` são controles separados, filhos de `Root`. `Hips` move o tronco. O carregador Three.js remove pontos dos nomes em memória; a busca usa `PropertyBinding.sanitizeNodeName`, sem renomear o rig.

`FootIK` resolve um triângulo de duas articulações em coordenadas do mundo. Um ponto virtual no espaço da canela mantém o endpoint dos pés separados. A compensação vertical atua em `Body`, e o pé recebe o endpoint efetivamente alcançado. Não há reparenting, alongamento de osso nem uso da pose de bind como substituta da animação.

- Correção máxima do contato: 12 cm, proporcional à estatura.
- Compensação da pelve: até 6,5 cm para baixo.
- Correção máxima por quadro sobre a pose: aproximadamente 26° na coxa e 45° na canela.
- A força do contato cai conforme o pé sobe no passo; terreno ausente ou muito inclinado libera o contato.
- A orientação da sola continua vindo do clipe. A versão atual ajusta altura, sem travar horizontalmente o pé nem inclinar a sola em rampas.

O mundo e a colisão atuais têm chão plano em `y=0`. `GameScene.groundAt` fornece esse chão, excluindo móveis e elementos decorativos. Uma cena futura pode substituir o sampler quando a locomoção compartilhada também representar alturas. O solver aceita superfícies em alturas diferentes; isto não cria escadas ou física de terreno no servidor.

## Head Look-at e custo

`HeadLook` divide a rotação entre pescoço (35%) e cabeça (65%), com suavização de 150 ms. O yaw é limitado a ±60°, o pitch a aproximadamente −22,5°/+25,7°. Um alvo atrás dos ombros libera o olhar. Os deltas são convertidos de espaço do mundo para o pai real do osso.

O jogador local acompanha a direção da câmera. Até 6 avatares próximos no tier médio ou 12 no alto recebem refinamento; o tier baixo mantém apenas o jogador local. O alcance é 16 m da câmera. Avatares próximos podem olhar para o jogador a até 6 m. Isso é apenas apresentação local, sem tráfego adicional ou autoridade de servidor.

Gestos, posição elevada, movimento vertical, teleporte, distância e orçamento de qualidade desativam a camada. Cards, retratos e figurantes sem contexto de chão ficam sem ela. O pin de animação das ferramentas visuais também a desativa para manter as capturas repetíveis.

## LOD: preparação entregue, ainda sem troca de malhas

`WardrobeLod.ts` fornece validação de manifesto, seleção com histerese e fallback. A entrada em LOD1 ocorre a 14 m, retornando a LOD0 abaixo de 10 m. LOD2 entra a 26 m e retorna abaixo de 22 m. Apenas cópias disponíveis podem ser selecionadas; falta ou falha retorna a um nível mais detalhado, chegando ao original.

Essa utilidade **não está ligada ao carregamento do AvatarV2**. Nenhum arquivo foi decimado ou ativado em runtime. Os alvos de aproximadamente 13k/7k/3k triângulos ainda exigem autoria, medição do conjunto vestido e revisão visual.

O manifesto admite somente `top`, `bottom` e `shoes`. Cabeça, olhos, boca e o forro `under_body` permanecem originais: `FaceV2` trabalha com ilhas específicas da geometria e o forro é recortado conforme a roupa. Decimar ou trocar essas malhas indiscriminadamente quebraria esse trabalho.

Formato do futuro `assets/wardrobe/lods/manifest.json`:

```json
{
  "version": 1,
  "parts": {
    "m_casual_character_top": {
      "slot": "top",
      "sourceSha256": "SHA256_REAL_DO_ORIGINAL",
      "levels": [
        {
          "level": 1,
          "file": "m_casual_character_top.lod1.glb",
          "triangles": 2000,
          "sha256": "SHA256_REAL_DA_COPIA"
        }
      ]
    }
  }
}
```

Os hashes devem ter 64 caracteres hexadecimais. Os números acima ilustram o formato, não uma medição de asset entregue. Cada cópia precisa preservar ossos, ordem, parentes, bind, materiais/primitivos e slots. Seus índices de skin continuam apontando aos mesmos 62 ossos; os pesos dos vértices novos precisam ser normalizados. Alterar a topologia da cópia não autoriza reescrever o original.

O portão somente lê arquivos:

```sh
node tools/assets/validate-wardrobe-lods.mjs caminho/manifest.json
```

Ele compara o original com `assets/rig-contract.json`, verifica hashes, rig completo, binds, layout dos primitivos, materiais, atributos de skin, índices, pesos e contagem de triângulos de cada cópia. Só aceita redução real de geometria. Um manifesto vazio não conta como validação bem-sucedida. Uma futura integração deve executar também os portões de guarda-roupa e rosto e medir memória, draw calls e tempo de quadro antes da ativação.

## Verificação

`npm run test:avatar-motion` cobre matemática do IK, transformações sob pais rotacionados/escalados, 600 quadros sem acúmulo, exclusão de gestos/airborne/LOD, seleção de LOD e fallback. Os testes com GLBs reais exercitam pés separados e os clipes Idle/Walk/Run dos dois rigs, conferindo restauração exata, alcance limitado e preservação dos 62 ossos e binds. A revisão visual continua sendo necessária para avaliar a naturalidade.
