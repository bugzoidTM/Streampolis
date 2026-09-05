# Movimento do avatar V2

O V2 continua usando as mesmas peças e o mesmo esqueleto do guarda-roupa. O servidor transmite movimento e gestos; o cliente combina clipes e aplica os ajustes visuais após `AnimationMixer.update()`.

## Locomoção

`LocomotionController` recebe a velocidade horizontal medida pelo `World`, em m/s. Abaixo de 0,08 m/s predomina Idle; a caminhada ganha peso até 0,65 m/s. Walk permanece integral na velocidade máxima de caminhada do protocolo (2,4 m/s). A transição para Run acontece entre 2,4 e 4,2 m/s.

Os pesos mudam gradualmente, somam um e são renormalizados quando algum clipe falta. Walk e Run compartilham a fase normalizada do passo. A cadência usa as velocidades nativas dos clipes existentes: 1,4 m/s e 3,6 m/s. Esses números são calibração visual, não limites de movimento ou validação de rede.

Gestos suspendem a locomoção com fade de 0,2 segundo. A fase da marcha é preservada. Trocas rápidas retomam os pesos atuais, evitando reativar um gesto antigo com peso integral. `anim` continua representando o estado pedido pelo servidor; `animationReport()` expõe os pesos reais e a origem/duração da dança para inspeção.

## Dança criada no Blender

O carregamento procura dois arquivos independentes:

- `packages/client/public/assets/animations/social_dance_m.glb`
- `packages/client/public/assets/animations/social_dance_f.glb`

Cada arquivo deve conter `SocialDance`, `social_dance` ou `Dance`, com quatro segundos e fechamento do ciclo. Apenas as faixas são usadas; a cena e o esqueleto importados nunca entram no avatar. O carregamento acontece junto com os clipes do pacote e não gera uma promessa rejeitada sem tratamento quando o arquivo está indisponível.

O portão de execução aceita somente posição/quaternion de ossos existentes, rejeita helper bones, propriedades de escala, faixas duplicadas, valores inválidos e ciclos abertos. Os arquivos masculino e feminino são separados porque as poses de bind diferem. O portão de autoria deve verificar também a fidelidade dessas poses e o movimento in-place antes de publicar o GLB.

Se o arquivo não carregar ou falhar no portão, a dança existente continua disponível. Os outros gestos autorados em `Clips.ts` são mantidos; seu cache agora inclui a pose de repouso para impedir que a primeira cabeça carregada determine as rotações do outro rig.

## Ajustes procedurais

`ProceduralPose.restore()` restaura o resultado anterior antes do mixer. `apply()` resolve pés, compensação da pelve e olhar sobre a nova pose. O `World` fornece o contexto de chão e olhar por `setProceduralFrame()`. Cards, retratos e figurantes sem esse contexto mantêm o comportamento anterior.

Nenhuma etapa modifica nomes/ordem dos 62 ossos, matrizes inversas de bind, `skinIndex` ou slots. Helper bones pertencem somente ao arquivo de autoria e suas influências devem ser baked antes de exportar.

## Verificação

`npm run test:avatar-motion` executa os testes de movimento do cliente. Eles verificam normalização, transições, fase dos passos, fallback, rejeição de animações inválidas e o contrato dos dois rigs usando os GLBs reais quando presentes. Quando os novos GLBs estão disponíveis, os mesmos testes verificam sua aceitação pelo carregador de execução.

`npm run typecheck --workspace @streampolis/client` e `npm run build --workspace @streampolis/client` verificam a integração. A revisão visual continua necessária para avaliar expressividade, contato com o chão e escolha de cadência, que não podem ser aprovados apenas por números.
