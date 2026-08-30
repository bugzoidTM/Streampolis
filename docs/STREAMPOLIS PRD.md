# STREAMPOLIS
## Product Requirements Document — PRD
### Versão 1.0 — Agosto de 2026

## 1. VISÃO DO PRODUTO

Streampolis é um jogo social multiplayer persistente para navegador que combina simulação de vida, cultura de transmissões ao vivo, economia virtual, competição entre streamers e interação social.

O jogador não interpreta necessariamente a si próprio diante de uma câmera. Ele cria um avatar e passa a viver dentro de Streampolis.

Esse avatar pode morar em um apartamento, comprar roupas e móveis, conhecer pessoas, trabalhar, frequentar locais públicos, entrar em uma agência, construir relacionamentos, assistir transmissões, tornar-se presenteador ou iniciar sua própria carreira como streamer.

Quando um jogador inicia uma live, não existe transmissão de webcam. O avatar entra ao vivo dentro do próprio mundo virtual.

Os espectadores assistem à cena 3D renderizada pelo próprio navegador, conversam pelo chat, seguem o criador, enviam reações e compram presentes virtuais.

A experiência mistura elementos de simulador de vida, rede social, jogo multiplayer e plataforma de lives, sem depender da distribuição contínua de vídeo convencional.

---

# 2. PROPOSTA CENTRAL

A proposta de Streampolis pode ser resumida em:

**“Uma vida virtual onde audiência, relacionamentos e fama fazem parte da economia.”**

A live não representa todo o jogo.

Ela é uma atividade dentro da vida do personagem.

O jogador pode:

Viver → socializar → trabalhar → melhorar sua casa → construir reputação → assistir lives → presentear → fazer lives → disputar PKs → entrar em uma agência → tornar-se famoso → abrir sua própria agência.

Não existirão classes permanentes.

Uma pessoa pode começar apenas assistindo lives, tornar-se um grande presenteador, iniciar uma carreira de streamer e posteriormente abandonar as transmissões para administrar uma agência.

---

# 3. PILARES DO PRODUTO

## 3.1 Vida virtual

Cada conta possui um avatar persistente.

O avatar terá:

- aparência;
- roupas;
- apartamento;
- inventário;
- patrimônio;
- amizades;
- seguidores;
- reputação;
- progressão;
- histórico de lives;
- nível de presenteador;
- vínculo com agência;
- estatísticas sociais.

O mundo continuará existindo independentemente de uma determinada live.

---

## 3.2 Lives virtuais

O jogador poderá iniciar uma transmissão virtual.

O sistema criará uma Live Room específica.

O avatar será o protagonista da transmissão.

Durante a live será possível:

- conversar pelo chat;
- executar emotes;
- dançar;
- sentar;
- caminhar pelo cenário;
- trocar poses;
- interagir com objetos;
- agradecer presentes;
- iniciar PK;
- convidar outro streamer;
- alterar enquadramento;
- moderar espectadores.

Nenhum streaming de webcam será necessário no MVP.

---

## 3.3 Audiência real

Outros jogadores podem acessar a live como espectadores.

Será exibido separadamente o número de jogadores reais presentes.

Caso futuramente sejam utilizados NPCs para povoar o universo ou simular seguidores virtuais, esses números não deverão ser apresentados como jogadores humanos reais.

A transparência entre atividade humana e atividade simulada será preservada.

---

# 4. PERSONAS DE JOGO

## Streamer

Faz lives, conquista audiência, recebe presentes, participa de PKs, melhora cenário, aumenta fama e pode integrar uma agência.

## Espectador

Explora lives, conversa, segue pessoas, participa de comunidades e constrói sua própria vida dentro da cidade.

## Presenteador

Compra moedas premium e envia presentes.

Possui progressão independente do streamer.

Quanto maior seu nível de presenteador, maior seu status social.

## Agente

Busca talentos e participa da gestão de streamers dentro de uma agência.

## Dono de agência

Cria uma organização, recruta streamers, constrói reputação coletiva e disputa posições no ranking de agências.

Essas funções não são classes bloqueadas.

O mesmo personagem pode exercer várias delas ao longo de sua trajetória.

---

# 5. CORE LOOP

O ciclo principal será:

**Explorar → socializar → produzir ou assistir → ganhar progressão → melhorar avatar/casa/status → voltar a interagir.**

Para o streamer:

**Preparar avatar → iniciar live → interagir → receber audiência → ganhar Fame/Creator Points → melhorar cenário → participar de PK → crescer.**

Para o espectador/presenteador:

**Descobrir live → assistir → conversar → seguir → presentear → aumentar Gifter Prestige → desbloquear status → socializar.**

---

# 6. MUNDO INICIAL

O MVP não utilizará um mundo aberto gigantesco.

Streampolis será dividido em ambientes menores e instanciados.

## Central Plaza

Área social principal.

Permite:

- encontrar jogadores;
- conversar;
- visualizar perfis;
- convidar para amizade;
- seguir;
- acessar outros locais.

## Residential Tower

Prédio onde ficam os apartamentos.

Cada apartamento corresponde a uma instância privada ou semiprivada.

## Stream Store

Loja de:

- móveis;
- decoração;
- roupas;
- acessórios;
- equipamentos de streamer;
- cosméticos.

## Agency Tower

Área dedicada às agências.

No MVP poderá existir inicialmente uma agência do sistema e posteriormente agências administradas pelos jogadores.

## PK Arena

Ambiente visual destinado às batalhas especiais e eventos.

---

# 7. SISTEMA DE AVATAR

O avatar deverá ser estilizado, atraente e relativamente leve para renderização em navegador.

Personalização inicial:

- tom de pele;
- rosto/preset;
- cabelo;
- cor do cabelo;
- corpo/preset;
- camiseta;
- calça;
- calçado;
- acessórios básicos.

Expansões posteriores:

- maquiagem;
- tatuagens;
- barba;
- acessórios faciais;
- roupas premium;
- animações;
- poses;
- efeitos;
- itens sazonais.

Todos os itens utilizados no MVP serão provenientes do catálogo oficial do jogo.

Não haverá upload livre de texturas ou imagens por usuários no início.

---

# 8. SISTEMA DE CASA

Todo jogador recebe inicialmente um pequeno apartamento.

No MVP não será implementado um editor arquitetônico completo.

O imóvel possui estrutura fixa.

O jogador poderá:

- escolher piso;
- escolher parede;
- posicionar móveis;
- girar objetos;
- remover objetos;
- guardar objetos;
- comprar decoração;
- montar seu setup de live.

Os móveis serão posicionados utilizando grid e pontos de encaixe para simplificar colisões e sincronização.

Futuramente poderão ser adicionados:

- casas maiores;
- mansões;
- cobertura;
- estúdios;
- construção de paredes;
- terrenos.

---

# 9. NECESSIDADES DO PERSONAGEM

Para manter elementos de simulador de vida, serão usados inicialmente quatro atributos:

**Energia**

Diminui com atividades e lives.

**Social**

Melhora por interações com outros personagens.

**Humor**

Influenciado por necessidades, atividades e acontecimentos.

**Conforto**

Relacionado à qualidade da casa, móveis e ambiente.

Esses sistemas não deverão impedir o jogador de participar do jogo de maneira excessivamente punitiva.

Servirão para criar decisões e incentivar variedade.

---

# 10. SISTEMA DE LIVE

O jogador pode iniciar uma live em locais compatíveis.

Inicialmente:

- apartamento;
- estúdio;
- arena.

Fluxo:

1. Jogador seleciona “Entrar ao vivo”.
2. Define título.
3. Define categoria.
4. Escolhe cenário.
5. Live Room é criada.
6. Perfil aparece no Feed.
7. Espectadores podem entrar.
8. Host controla avatar e interações.
9. Estatísticas são registradas.
10. Ao finalizar, é exibido resumo.

Resumo:

- duração;
- espectadores únicos;
- pico simultâneo;
- novos seguidores;
- mensagens;
- likes;
- presentes recebidos;
- Creator Points;
- Fame obtida.

---

# 11. LIVE FEED

O jogo possuirá uma interface específica para descoberta.

No celular, o Feed poderá ser vertical.

Cada card apresentará:

- avatar;
- nome;
- título;
- categoria;
- espectadores reais;
- indicador de PK;
- agência;
- selo/status.

Ao tocar, o jogador entra na Live Room.

O ambiente completo da cidade não precisa ser carregado durante essa experiência.

Isso permitirá uma cena muito mais leve.

---

# 12. INTERFACE DO ESPECTADOR

A tela terá:

**Área 3D principal**

Avatar e cenário.

**Chat**

Mensagens em tempo real.

**Follow**

Seguir streamer.

**Like**

Reação gratuita.

**Gift**

Abrir catálogo de presentes.

**Profile**

Perfil do streamer.

**PK**

Pontuação quando houver batalha.

O espectador poderá escolher alguns enquadramentos pré-definidos da câmera.

Exemplo:

- padrão;
- close;
- corpo inteiro;
- ambiente.

---

# 13. PRESENTES

Presentes são elementos centrais da experiência e do modelo de negócio.

Cada presente possui:

- ID;
- nome;
- categoria;
- preço em Coins;
- animação;
- efeito sonoro;
- Creator Points;
- PK Points;
- raridade;
- disponibilidade.

Exemplos conceituais:

Rosa  
Café  
Coração  
Diamante  
Rocket  
Coroa

Presentes mais caros geram experiências visuais mais elaboradas.

Exemplo:

Ao enviar Rocket, uma animação tridimensional pode atravessar a Live Room.

---

# 14. ECONOMIA

Streampolis terá três elementos financeiros separados.

## Credits

Moeda normal do jogo.

Conquistada jogando.

Utilizada para:

- móveis básicos;
- roupas básicas;
- alimentação/atividades;
- itens comuns.

Não pode ser comprada diretamente em determinadas situações que comprometam a progressão.

## Coins

Moeda premium.

Comprada com dinheiro real.

Utilizada para:

- presentes;
- cosméticos premium;
- efeitos;
- itens especiais.

Coins:

- não poderão ser transferidos diretamente entre jogadores;
- não serão sacáveis;
- não representarão moeda corrente;
- não poderão ser apostados.

## Creator Points

Pontuação recebida pelo streamer quando recebe presentes.

No MVP:

**Creator Points não têm conversão para dinheiro.**

Servirão para:

- ranking;
- progressão;
- desbloqueios;
- reputação;
- eventos.

Essa separação permitirá lançar monetização antes de implementar pagamentos aos criadores.

---

# 15. MONETIZAÇÃO DO MVP

A primeira monetização será baseada principalmente em Coins.

Fluxo:

Dinheiro real → Coins → Gift/Item Premium.

A receita obtida com a venda de Coins pertence à plataforma no MVP.

O sistema deverá deixar explicitamente claro que o envio de presentes não representa transferência de dinheiro ao destinatário.

Posteriormente poderá ser criado o Creator Program.

---

# 16. CREATOR PROGRAM — FASE POSTERIOR

Somente depois da validação da economia deverá ser criado um sistema de remuneração real.

O programa exigirá análise específica de:

- identidade;
- idade;
- CPF;
- tributação;
- antifraude;
- chargeback;
- saque;
- Pix;
- documentação;
- regras comerciais.

Creator Points existentes não deverão automaticamente se transformar em obrigação financeira retroativa.

---

# 17. Gifter Prestige

Presentear também será uma forma de progressão.

Exemplo de títulos:

Viewer  
Supporter  
Fan  
VIP  
Elite  
Legend  
Icon

Benefícios poderão incluir:

- badge;
- efeito de entrada;
- moldura;
- emotes;
- itens cosméticos;
- prioridade visual em eventos;
- reconhecimento dentro das lives.

Não deverá conceder poderes que prejudiquem a competição.

---

# 18. PK

PK será uma competição entre dois streamers.

Fluxo:

Desafiar → Aceitar → Countdown → Batalha → Resultado.

Configuração inicial:

Duração padrão: 180 segundos.

Pontuação derivada principalmente de presentes.

Likes e chat não possuirão valor financeiro ou pontuação significativa.

Tela:

STREAMER A vs STREAMER B

Pontuação A | Timer | Pontuação B

Durante o PK:

- presentes alimentam placar;
- efeitos aparecem;
- espectadores permanecem no mesmo ambiente;
- os dois avatares são exibidos.

Empate:

30 segundos de overtime.

Não haverá apostas.

Nenhum espectador recebe prêmio financeiro com base no resultado.

---

# 19. AGÊNCIAS

Agências serão organizações dentro do universo.

Cada agência terá:

- nome;
- logo oficial selecionável;
- sede;
- nível;
- reputação;
- membros;
- streamers;
- agentes;
- ranking;
- histórico;
- metas.

Funções:

Owner  
Manager  
Agent  
Streamer

O MVP poderá começar com estrutura simplificada.

Em versão posterior:

- propostas;
- contratos;
- metas;
- bônus;
- rankings;
- guerras entre agências;
- eventos.

---

# 20. RELACIONAMENTOS SOCIAIS

O jogador poderá:

- seguir;
- deixar de seguir;
- adicionar amigo;
- remover amigo;
- bloquear;
- silenciar;
- visitar perfil;
- convidar para apartamento;
- convidar para live;
- convidar para PK.

Progressões sociais mais profundas poderão ser introduzidas posteriormente.

---

# 21. PERFIL

Cada jogador possuirá página pública contendo:

- avatar;
- nome;
- bio;
- Fame;
- seguidores;
- seguindo;
- Gifter Level;
- Streamer Rank;
- agência;
- badges;
- principais estatísticas;
- coleção selecionada;
- apartamento público, se habilitado.

Configurações de privacidade deverão ser respeitadas.

---

# 22. FAMA

Fame representa notoriedade dentro de Streampolis.

Pode ser conquistada por:

- espectadores;
- novos seguidores;
- lives;
- PKs;
- eventos;
- missões;
- Creator Points.

O algoritmo não deverá ser diretamente proporcional ao dinheiro gasto por terceiros.

Engajamento e consistência também deverão influenciar.

---

# 23. RANKINGS

Inicialmente:

Top Streamers  
Top Gifters  
Top PK  
Top Agencies

Filtros:

Hoje  
Semana  
Temporada

Rankings sazonais evitam que jogadores antigos dominem permanentemente.

---

# 24. MISSÕES

Missões ajudam novos jogadores a entender o jogo.

Exemplos:

Complete seu avatar.

Visite a praça.

Conheça outro jogador.

Assista a uma live.

Siga um streamer.

Personalize seu apartamento.

Faça sua primeira live.

Participe de um PK.

Recompensas devem utilizar Credits, XP e cosméticos iniciais.

---

# 25. CONTEÚDO NPC

NPCs poderão ser utilizados para:

- lojas;
- tutorial;
- trabalhos;
- eventos;
- missões;
- ambientação.

NPCs nunca deverão ser apresentados como jogadores humanos reais.

---

# 26. TRABALHOS

Além de lives, personagens poderão ganhar Credits realizando atividades.

MVP:

- atendente;
- entregas virtuais;
- tarefas diárias;
- pequenos gigs.

Posteriormente:

- bartender;
- stylist;
- fotógrafo;
- DJ;
- produtor;
- agente;
- empresário.

Isso permite que uma pessoa prospere sem obrigatoriamente se tornar streamer.

---

# 27. SEGURANÇA SOCIAL

Recursos obrigatórios:

- bloquear;
- mutar;
- denunciar;
- filtro de termos;
- limite de mensagens;
- moderação de usernames;
- moderação de títulos de live;
- histórico de denúncias;
- banimento temporário;
- banimento permanente.

No primeiro lançamento monetizado, recomenda-se restringir a plataforma a maiores de 18 anos enquanto as políticas de menores, compras e proteção infantil não estiverem completamente estruturadas.

---

# 28. ADMINISTRAÇÃO

Painel administrativo deve permitir:

Usuários:
- localizar;
- suspender;
- banir;
- silenciar;
- analisar histórico.

Lives:
- visualizar ativas;
- finalizar;
- bloquear host.

Economia:
- consultar carteira;
- visualizar transações;
- ajustar saldo com motivo obrigatório;
- bloquear carteira;
- configurar pacotes.

Conteúdo:
- presentes;
- itens;
- preços;
- missões;
- eventos.

Agências:
- consultar;
- suspender;
- editar.

Moderadores:
- fila de denúncias;
- decisões;
- histórico.

---

# 29. PRINCÍPIOS DE ECONOMIA

Nenhuma operação financeira será confiada ao navegador.

O cliente nunca poderá determinar:

“Eu tenho 1.000 Coins.”

O servidor deverá determinar:

“O usuário possui 1.000 Coins.”

Toda movimentação premium deverá criar uma entrada imutável de ledger.

Cada transação deverá possuir:

- ID;
- usuário;
- tipo;
- valor;
- saldo anterior;
- saldo posterior;
- origem;
- timestamp;
- idempotency key.

---

# 30. ESCOPO DO MVP

### Deve existir

Autenticação  
Criação de avatar  
Mundo multiplayer  
Praça  
Apartamento  
Loja  
Inventário  
Movimentação  
Chat  
Perfil  
Follow  
Live virtual  
Feed de lives  
Likes  
Presentes  
Coins  
Checkout  
Creator Points  
Gifter Prestige  
PK 1x1  
Rankings  
Moderação básica  
Painel administrativo

### Não é requisito do MVP

Webcam  
Vídeo ao vivo  
Voz  
IA conversacional  
Construção completa de casas  
Carros dirigíveis  
Casamento  
Família/filhos  
Mercado entre jogadores  
Saque de dinheiro  
Creator Program financeiro  
Aplicativos nativos  
VR  
Mundo aberto contínuo

---

# 31. MÉTRICAS DE PRODUTO

Indicadores principais:

DAU  
WAU  
MAU  
D1 retention  
D7 retention  
tempo médio de sessão  
lives iniciadas/dia  
tempo assistido  
espectadores únicos/live  
follows/live  
PKs realizados  
taxa de jogadores que enviam gifts  
conversão para comprador  
ARPPU  
Coins vendidos  
Coins consumidos  
gasto médio por presenteador  
quantidade de interações sociais  
FPS médio  
latência de multiplayer  
erros de cliente  
desconexões  
custo de infraestrutura por usuário simultâneo

---

# 32. NORTH STAR

A principal métrica de produto não será dinheiro gasto.

Será:

**Weekly Socially Active Players**

Jogadores que, durante a semana, realizaram ao menos uma interação significativa com outro jogador:

- live;
- chat;
- follow;
- friendship;
- gift;
- PK;
- visita;
- agência.

Isso mede se Streampolis está realmente funcionando como mundo social.

---

# 33. CRITÉRIOS DE SUCESSO DO ALPHA

O Alpha deverá demonstrar:

- dezenas de jogadores simultâneos no mesmo ecossistema;
- movimentação multiplayer estável;
- live virtual sem vídeo;
- espectadores assistindo ao avatar;
- chat funcional;
- presente aparecendo em tempo real;
- PK completo;
- persistência de conta;
- apartamento persistente;
- economia sem duplicação de saldo;
- desempenho aceitável em notebooks e celulares intermediários.

---

# 34. EVOLUÇÃO DO PRODUTO

## Vertical Slice

Avatar  
Praça  
Multiplayer  
Apartamento  
Live  
Espectador  
Chat  
Gift virtual de teste

## Alpha

Economia completa  
Inventário  
Loja  
PK  
Feed  
Perfis  
Rankings  
Admin

## Beta

Coins reais  
Checkout  
Agências  
Eventos  
Progressão ampliada  
Mais locais  
Mais itens

## Expansão

Creator Program  
Áudio ao vivo  
Eventos massivos  
Reality Houses  
Agências complexas  
Empregos administrados por jogadores  
Novos bairros  
Aplicativo/PWA ampliado

---

# 35. IDENTIDADE DO PRODUTO

Nome:

**STREAMPOLIS**

Tagline:

**Live your life. Build your audience.**

Posicionamento:

**A multiplayer virtual world built around live culture.**

Streampolis não será apresentado como clone de The Sims, TikTok ou qualquer outra plataforma.

Essas referências poderão orientar internamente conceitos de produto, mas identidade visual, personagens, interface, nomenclaturas, objetos e mecânicas deverão possuir linguagem própria.