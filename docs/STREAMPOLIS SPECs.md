# STREAMPOLIS
## TECHNICAL SPECIFICATIONS
### Web Multiplayer Life Simulation
### Three.js Architecture — Version 1.0

# 1. STACK PRINCIPAL

## Frontend

TypeScript  
React  
Vite  
Three.js  
Zustand  
CSS/Tailwind para HUD e interfaces DOM  
Colyseus Web SDK

React será responsável principalmente por:

- HUD;
- menus;
- loja;
- perfil;
- chat;
- inventário;
- feed;
- checkout.

Three.js será utilizado diretamente como engine gráfica.

Não será obrigatório utilizar React Three Fiber.

A cena Three.js terá seu próprio Game/Scene Manager e será integrada à camada React.

---

# 2. RENDERIZAÇÃO

Renderer inicial:

**THREE.WebGLRenderer**

Baseline:

WebGL 2.

O projeto deverá manter uma camada abstrata de renderer para permitir avaliação futura de WebGPU sem reescrever regras do jogo.

Não utilizar WebGPU como requisito obrigatório do MVP.

---

# 3. ASSETS 3D

Formato principal:

**glTF / GLB**

Padrão:

- geometria otimizada;
- poucos materiais;
- texturas compartilhadas;
- animações incluídas quando necessário.

Compressão:

**Draco** para meshes quando oferecer benefício.

Texturas:

**KTX2 / Basis Universal**.

Objetivo:

reduzir download e consumo de VRAM.

---

# 4. ESTILO VISUAL

Direção recomendada:

3D estilizado semi-cartoon.

Evitar realismo fotográfico.

Benefícios:

- menos polígonos;
- materiais simples;
- animação mais tolerante;
- melhor desempenho;
- maior identidade visual;
- produção de conteúdo mais barata.

Personagens deverão ter silhuetas claramente reconhecíveis.

---

# 5. PERFORMANCE GRÁFICA

Meta desktop:

60 FPS.

Meta dispositivos modestos:

30 FPS estáveis.

Qualidade configurável:

Low  
Medium  
High

Low deverá reduzir:

- sombras;
- distância de renderização;
- resolução;
- partículas;
- pós-processamento;
- quantidade de NPCs decorativos.

---

# 6. PIXEL RATIO

O renderer não deverá usar indiscriminadamente:

devicePixelRatio completo.

Aplicar limite dinâmico.

Exemplo conceitual:

Desktop High:
máximo 2.

Desktop Medium:
máximo 1.5.

Mobile:
máximo 1.25–1.5.

A resolução poderá ser reduzida automaticamente quando o FPS cair.

---

# 7. DRAW CALLS

Metas deverão ser acompanhadas pelo renderer.info.

Objetos repetitivos utilizarão:

**THREE.InstancedMesh**

Exemplos:

- árvores;
- postes;
- bancos;
- cadeiras;
- decoração;
- elementos urbanos.

Materiais deverão ser compartilhados sempre que possível.

---

# 8. ILUMINAÇÃO

O MVP utilizará iluminação predominantemente baked.

Evitar múltiplas luzes dinâmicas com sombras.

Estrutura recomendada:

1 Directional Light principal  
1 Hemisphere/Ambient Light  
lightmaps/baked lighting quando aplicável

Sombras dinâmicas:

somente personagens e objetos importantes.

---

# 9. CENAS

Cada área importante será uma cena independente.

Scene IDs:

central_plaza  
residential_lobby  
apartment  
stream_store  
agency_tower  
pk_arena  
live_room

O cliente descarregará recursos desnecessários ao trocar de ambiente.

---

# 10. LIVE ROOM OTIMIZADA

Uma live não carregará a cidade inteira.

Ela carregará somente:

- cenário;
- streamer;
- eventual segundo streamer;
- alguns objetos;
- animações;
- efeitos;
- UI.

O espectador não necessita sincronizar dezenas de avatares.

Isso transforma Live Rooms em instâncias extremamente leves em comparação com áreas públicas.

---

# 11. CLIENT ARCHITECTURE

Estrutura sugerida:

src/

app/
ui/
game/
network/
audio/
economy/
features/
assets/
workers/
utils/

game/

Game.ts  
Renderer.ts  
SceneManager.ts  
AssetManager.ts  
CameraManager.ts  
InputManager.ts  
EntityManager.ts  
AnimationManager.ts  
QualityManager.ts

network/

NetworkClient.ts  
WorldRoomClient.ts  
LiveRoomClient.ts  
PKRoomClient.ts  
PresenceClient.ts

---

# 12. ASSET MANAGER

AssetManager deverá:

- carregar GLB;
- armazenar cache;
- contar referências;
- descarregar recursos;
- carregar KTX2;
- configurar Draco;
- apresentar progresso;
- impedir carregamento duplicado.

Assets deverão ser carregados por área.

---

# 13. AVATAR

Avatar modular.

Estrutura:

BaseBody  
Hair  
Top  
Bottom  
Shoes  
Accessory

Evitar criar um GLB completo para cada combinação.

Peças deverão compartilhar rig sempre que possível.

Skeleton único padronizado.

---

# 14. ANIMAÇÕES

Sistema baseado em:

THREE.AnimationMixer.

Estado básico:

Idle  
Walk  
Run  
Sit  
Wave  
Clap  
Dance  
Celebrate  
GiftReact  
PKWin  
PKLose

State machine deverá controlar transições.

---

# 15. MOVIMENTAÇÃO

Desktop:

WASD  
mouse/câmera

Mobile:

virtual joystick  
touch camera

Movimento deverá ser enviado como input/intenção.

Evitar confiar cegamente na posição enviada pelo cliente.

---

# 16. NETWORKING

Servidor multiplayer:

**Colyseus + Node.js + TypeScript**

Modelo:

server authoritative.

Cliente solicita ações.

Servidor valida.

Servidor altera estado.

Clientes recebem alterações.

---

# 17. TIPOS DE ROOM

## CityRoom

Responsável por:

- avatares;
- posição;
- estado social imediato;
- emotes.

Capacidade inicial alvo:

aproximadamente 30–40 jogadores.

Ao atingir limite:

novo shard.

Exemplo:

central-plaza-001  
central-plaza-002

---

## ApartmentRoom

Capacidade:

owner + convidados.

Alvo inicial:

12 jogadores.

---

## LiveRoom

Sincroniza:

- host;
- co-host;
- estado da live;
- PK;
- placar;
- gift events;
- reações relevantes.

Espectadores não possuem necessidade de movimentação completa.

Alvo inicial:

100 espectadores simultâneos por Room durante Alpha.

Load tests deverão determinar limites reais antes de aumentar.

---

## PKRoom

Pode ser implementação especializada de LiveRoom.

Estado:

hostA  
hostB  
scoreA  
scoreB  
timer  
phase  
gifts

---

## AgencyRoom

Ambiente social de uma agência.

---

# 18. TICK RATE

Movimentação do mundo:

20–30 ticks por segundo no servidor.

Renderização:

independente do tick.

Cliente utilizará:

interpolation.

Para jogador local:

client-side prediction.

Servidor corrigirá divergências.

---

# 19. POSIÇÃO DE AVATAR

Estado sincronizado mínimo:

playerId  
positionX  
positionY  
positionZ  
rotationY  
animationState  
movementState

Não transmitir informações cosméticas completas continuamente.

Cosméticos são enviados no join ou quando alterados.

---

# 20. INTERPOLAÇÃO

Remote avatars serão apresentados com pequeno buffer.

Fluxo:

state A → state B

Three.js interpola posição visualmente.

Nunca mover avatares remotos diretamente usando cada pacote recebido.

Isso evita jitter.

---

# 21. SERVER VALIDATION

Servidor deverá verificar:

- velocidade máxima;
- distância percorrida;
- área permitida;
- teleporte;
- estado do jogador;
- cooldown;
- permissões.

Economia jamais depende dessa sincronização de posição.

---

# 22. DATABASE

Persistência principal:

**PostgreSQL**

Pode ser operado através da instalação Supabase/Postgres existente ou Postgres independente.

Dados persistentes não deverão residir somente em memória do servidor multiplayer.

---

# 23. REDIS

Redis será utilizado para:

- Presence do Colyseus;
- comunicação entre processos;
- cache;
- rate limiting;
- sessões rápidas;
- eventos entre shards.

Necessário quando houver múltiplos processos Colyseus.

---

# 24. MODELO DE DADOS

Principais tabelas:

users

id  
email  
username  
password_hash/auth_provider  
status  
birth_date/age_verified  
created_at

avatars

id  
user_id  
body_preset  
skin  
hair  
top  
bottom  
shoes  
accessory

player_stats

user_id  
level  
xp  
fame  
gifter_xp  
gifter_level  
creator_points  
followers_count

wallets

user_id  
credits_balance  
coins_balance

wallet_transactions

id  
user_id  
currency  
type  
amount  
balance_before  
balance_after  
reference_type  
reference_id  
idempotency_key  
created_at

coin_packages

id  
name  
coins  
price  
currency  
active

gift_catalog

id  
name  
coin_cost  
creator_points  
pk_points  
animation_id  
rarity  
active

gift_events

id  
sender_id  
receiver_id  
live_id  
gift_id  
quantity  
coin_total  
creator_points  
created_at

stream_sessions

id  
host_id  
title  
category  
room_id  
started_at  
ended_at  
peak_real_viewers  
unique_viewers  
likes  
gift_coin_total

stream_viewers

stream_id  
user_id  
joined_at  
left_at

pk_matches

id  
host_a  
host_b  
stream_id  
status  
score_a  
score_b  
started_at  
ended_at  
winner_id

follows

follower_id  
followed_id  
created_at

friendships

user_a  
user_b  
status

inventory

id  
user_id  
item_id  
quantity

items

id  
type  
name  
rarity  
credits_price  
coins_price  
asset_id  
active

properties

id  
owner_id  
property_type  
layout_id

property_items

property_id  
item_instance_id  
position  
rotation

agencies

id  
owner_id  
name  
level  
fame  
created_at

agency_members

agency_id  
user_id  
role  
joined_at

moderation_reports

id  
reporter_id  
target_id  
type  
reason  
status  
created_at

---

# 25. ECONOMY SERVICE

Economia premium terá serviço independente da lógica visual.

Responsabilidades:

purchaseCoins()

spendCoins()

grantCredits()

spendCredits()

sendGift()

refundTransaction()

adminAdjustment()

Toda operação deverá executar em transação PostgreSQL.

---

# 26. SEND GIFT

Fluxo obrigatório:

CLIENT  
↓  
LiveRoom  
↓  
EconomyService  
↓  
BEGIN DB TRANSACTION  
↓  
lock wallet  
↓  
validate balance  
↓  
deduct Coins  
↓  
create wallet transaction  
↓  
create gift event  
↓  
grant Creator Points  
↓  
COMMIT  
↓  
publish GiftEvent  
↓  
LiveRoom  
↓  
ALL VIEWERS

Nunca:

CLIENT → “deduct locally” → SERVER.

---

# 27. IDEMPOTÊNCIA

Cada operação monetária deve possuir:

idempotency_key.

Caso o navegador envie a mesma ação duas vezes devido à rede, apenas uma transação deverá ocorrer.

---

# 28. CHECKOUT

Arquitetura:

Frontend  
↓  
Payments API  
↓  
Gateway  
↓  
Payment  
↓  
Webhook  
↓  
Payments API  
↓  
Wallet Ledger

Nunca liberar Coins apenas porque o frontend informou que o pagamento foi concluído.

Somente webhook validado poderá creditar saldo.

---

# 29. GATEWAY

Criar abstração:

PaymentProvider.

Métodos:

createPayment()  
getPayment()  
processWebhook()  
refund()

Isso permite trocar fornecedor sem reescrever a economia.

O MVP brasileiro poderá utilizar Pix e cartão conforme gateway escolhido.

---

# 30. LIVE GIFT EVENT

GiftEvent de rede:

eventId  
senderId  
senderName  
gifterLevel  
giftId  
quantity  
animationId  
receiverId  
pkPoints  
timestamp

GiftEvent é evento transitório.

Saldo financeiro não deve ser armazenado apenas em Room State.

---

# 31. CHAT

Chat via WebSocket.

Message:

id  
roomId  
senderId  
senderName  
text  
timestamp

Proteções:

rate limit  
spam detection  
block list  
mute  
profanity filter  
max length

O servidor controla envio.

---

# 32. LIKES

Likes são eventos leves.

Evitar persistir individualmente cada clique em banco.

Agregar em memória/Redis e persistir contadores periodicamente.

Rate limit por usuário.

---

# 33. PK ENGINE

State:

WAITING  
COUNTDOWN  
ACTIVE  
OVERTIME  
FINISHED

Servidor controla timer.

Cliente apenas renderiza.

Gift validado:

PKEngine.addPoints(team, gift.pkPoints)

Resultado calculado exclusivamente pelo servidor.

---

# 34. FOLLOW SYSTEM

Follow executado pela API.

Após sucesso:

atualizar relacionamento.

Publicar atualização para LiveRoom.

Host recebe evento:

newFollower.

---

# 35. PRESENCE

Status:

offline  
online  
in_world  
watching_live  
streaming  
in_pk

Redis poderá manter presença efêmera.

PostgreSQL guarda somente dados relevantes.

---

# 36. AUTH

Tokens curtos para API/WebSocket.

Refresh seguro.

Nunca enviar credenciais pelo WebSocket.

Colyseus Room deverá autenticar jogador durante entrada.

Room recebe:

userId  
permissions  
session.

Não confiar em userId enviado arbitrariamente pelo navegador.

---

# 37. SECURITY

Obrigatório:

HTTPS  
WSS  
secure headers  
rate limiting  
input validation  
SQL parametrizado/ORM seguro  
JWT rotation  
password hashing apropriado  
audit logs  
CSRF quando aplicável  
webhook signature verification  
admin RBAC

---

# 38. ANTI-CHEAT

Servidor autoritativo para:

- Coins;
- Credits;
- gifts;
- inventário;
- compras;
- XP;
- Fame;
- PK;
- movimento relevante;
- recompensas.

Cliente pode sugerir ação.

Nunca confirmar resultado econômico.

---

# 39. MODERATION

APIs:

reportUser()  
blockUser()  
muteUser()  
kickFromLive()  
banUser()

Host pode:

- silenciar usuário na própria live;
- remover da live.

Admin/moderador pode:

- suspender conta;
- suspender chat;
- encerrar live;
- bloquear economia.

---

# 40. CONTENT SAFETY

MVP não permitirá:

- webcam;
- upload de fotos;
- upload de vídeo;
- upload de áudio;
- texturas personalizadas;
- imagens personalizadas na casa.

Isso reduz drasticamente superfície de moderação inicial.

---

# 41. CDN / OBJECT STORAGE

Assets 3D não deverão sair do servidor Node a cada acesso.

Utilizar object storage/CDN para:

GLB  
KTX2  
áudio  
efeitos  
UI assets

Configurar:

cache-control immutable

para arquivos versionados.

---

# 42. VERSIONAMENTO DE ASSETS

Exemplo:

avatar_hair_01.v3.glb

ou content hash.

Evitar substituir arquivo mantendo mesma URL.

---

# 43. LAZY LOADING

Fluxo inicial:

App shell  
↓  
Avatar mínimo  
↓  
Cena atual  
↓  
assets secundários

Não baixar:

PK Arena

se o jogador está apenas no apartamento.

---

# 44. BUDGET DE ASSETS

Meta inicial recomendada:

First Play:
até aproximadamente 20 MB comprimidos.

Live Room:
manter pacote-base pequeno e reutilizar assets armazenados em cache.

Áreas adicionais carregadas sob demanda.

---

# 45. LEVEL OF DETAIL

Objetos maiores poderão possuir:

LOD0  
LOD1  
LOD2

Avatares distantes poderão:

- reduzir skeleton updates;
- usar animações simplificadas;
- desaparecer além da distância útil.

---

# 46. CULLING

Utilizar:

frustum culling.

Para interiores:

descarregar ambientes externos quando invisíveis.

Não manter a cidade inteira ativa atrás de paredes.

---

# 47. PARTICLES

Presentes premium podem utilizar partículas.

Definir limite de partículas simultâneas.

Presentes enviados em grande quantidade devem agrupar efeitos.

Exemplo:

Rosa x100

não cria 100 sistemas completos.

Cria um efeito combinado.

---

# 48. AUDIO

MVP:

efeitos sonoros locais.

Não existe live voice.

Áudio dos presentes e ambiente deve respeitar:

mute global  
volume  
visibility state.

---

# 49. VOICE — FUTURO

Áudio ao vivo deverá ser módulo separado.

Possível arquitetura futura:

WebRTC + SFU.

Não conectar voz à arquitetura principal do multiplayer até validação do MVP.

---

# 50. FRONTEND LIVE FEED

Feed usa API para descobrir lives.

GET /lives

Retorno:

liveId  
host  
avatarPreview  
title  
category  
realViewers  
isPK  
agency  
startedAt

Ao tocar:

join LiveRoom.

---

# 51. API REST

Endpoints iniciais:

/auth/*  
/users/*  
/profile/*  
/avatar/*  
/inventory/*  
/items/*  
/wallet/*  
/payments/*  
/lives/*  
/follows/*  
/friends/*  
/agencies/*  
/reports/*  
/admin/*

Movimentação e eventos em tempo real permanecem no Colyseus.

---

# 52. SEPARAÇÃO API / GAME SERVER

API Server:

persistência  
auth  
economia  
perfil  
payments  
admin

Game Server:

movimento  
presence em Room  
live state  
PK  
eventos em tempo real

Ambos podem iniciar na mesma VPS, mas permanecer em serviços separados.

---

# 53. INFRAESTRUTURA INICIAL

Reverse Proxy

NGINX ou equivalente.

Containers:

web  
api  
game-server  
redis  
postgres/supabase  
worker  
admin

Assets:

object storage/CDN.

---

# 54. PROCESSOS COLYSEUS

Inicialmente:

1 ou poucos processos.

Quando necessário:

múltiplos processos usando Redis Presence/Driver.

Shard automático de áreas públicas.

---

# 55. OBSERVABILITY

Registrar:

CPU  
RAM  
event loop lag  
WebSocket connections  
rooms  
players/room  
messages/sec  
bytes/sec  
API latency  
DB latency  
Redis latency  
errors  
disconnects  
FPS client sample

---

# 56. CLIENT TELEMETRY

Enviar amostras de:

FPS  
device category  
GPU renderer quando disponível  
RAM estimada  
load time  
disconnect  
crash/error

Não coletar informações desnecessárias.

---

# 57. QUALITY MANAGER

Detectar capacidade do dispositivo.

Escolher preset inicial.

Se FPS permanecer baixo:

reduzir pixel ratio  
desabilitar shadows  
reduzir particles  
reduzir draw distance

Permitir ajuste manual.

---

# 58. RESPONSIVIDADE

Desktop:

HUD lateral/inferior.

Mobile:

interface touch.

Live Feed:

portrait-first.

World mode:

responsivo em portrait e landscape, sem exigir instalação.

---

# 59. PWA

Após estabilização do navegador:

manifest  
service worker  
asset caching  
install prompt

Nunca cachear respostas financeiras sensíveis como se fossem assets estáticos.

---

# 60. TESTES

Unit:

economia  
PK  
progressão  
permissions

Integration:

payments  
gift transactions  
wallet concurrency  
follow  
inventory

Load:

CityRoom  
LiveRoom  
chat  
gift burst  
Redis  
API

E2E:

criar usuário  
criar avatar  
entrar na cidade  
abrir live  
assistir com segunda conta  
comprar Coins sandbox  
enviar gift  
iniciar PK  
finalizar live

---

# 61. TESTE CRÍTICO DE CARTEIRA

Criar cenário:

Saldo = 100 Coins.

Enviar simultaneamente:

Gift 70  
Gift 70

Resultado correto:

apenas um aprovado.

Nunca permitir:

saldo = -40.

---

# 62. TESTE CRÍTICO DE WEBHOOK

Enviar mesmo webhook várias vezes.

Resultado:

Coins creditados apenas uma vez.

---

# 63. TESTE CRÍTICO DE PK

Dois presentes chegam praticamente simultaneamente no último tick.

Servidor deve:

ordenar/processar consistentemente  
atualizar pontuação  
fechar batalha após processamento permitido  
produzir um único resultado.

---

# 64. FEATURE FLAGS

Implementar flags para:

real_payments  
pk_enabled  
agencies_enabled  
voice_enabled  
creator_program  
gift_catalog_v2

Permite lançar funcionalidades seletivamente.

---

# 65. ADMIN ECONOMY AUDIT

Nenhum administrador poderá simplesmente alterar saldo sem registro.

Admin adjustment exige:

adminId  
userId  
amount  
currency  
reason  
timestamp.

---

# 66. BACKUP

PostgreSQL:

backup automático.

Wallet ledger é informação crítica.

Testar restauração.

Não considerar backup válido sem teste periódico de restore.

---

# 67. ROADMAP TÉCNICO

## Technical Spike

Three.js  
2 avatares  
Colyseus  
movimentação  
interpolação  
chat  
gift animation falsa

## Vertical Slice

auth  
avatar  
apartamento  
live room  
espectador  
gift com moeda de teste  
PK

## Alpha

persistência completa  
wallet  
inventário  
feed  
ranking  
admin  
moderação

## Monetized Beta

payment gateway  
Coins reais  
gift catalog  
analytics financeiros  
antifraude básico

## Social Expansion

agências  
eventos  
trabalhos  
novos bairros  
mais casas

## Creator Expansion

Creator Program  
KYC  
Pix payout  
revenue share

---

# 68. REGRAS DE ARQUITETURA

### Regra 1

Three.js renderiza.

Não decide economia.

### Regra 2

Colyseus sincroniza mundo e eventos.

Não substitui banco persistente.

### Regra 3

PostgreSQL é fonte de verdade para dados permanentes.

### Regra 4

Wallet Ledger é fonte de verdade para economia.

### Regra 5

Redis guarda estado rápido e distribuído, não patrimônio permanente.

### Regra 6

O cliente nunca é autoridade sobre dinheiro, inventário ou PK.

### Regra 7

Live virtual deve ser significativamente mais leve que City Room.

### Regra 8

Nenhuma funcionalidade futura deverá exigir streaming de vídeo para que o núcleo do produto funcione.

---

# 69. PRIMEIRA PROVA DE CONCEITO

A primeira build tecnicamente válida de Streampolis deverá conter apenas:

Uma pequena praça 3D.

Dois ou mais usuários reais.

Avatares visíveis.

Movimentação sincronizada.

Nome sobre personagem.

Chat.

Um apartamento.

Botão “Go Live”.

Outra conta entrando como espectador.

Streamer executando animação.

Botão de Gift.

Gift aparecendo em ambos os navegadores.

PK entre dois avatares.

Se esse fluxo funcionar de ponta a ponta, o núcleo tecnológico e econômico conceitual de Streampolis estará comprovado.

---

# 70. DEFINIÇÃO TÉCNICA FINAL

**STREAMPOLIS não é uma plataforma de vídeo com jogo adicionado.**

É um jogo multiplayer persistente cuja infraestrutura também funciona como plataforma de live virtual.

O navegador recebe:

estado  
inputs  
eventos  
assets

e produz localmente:

mundo  
personagens  
câmeras  
animações  
efeitos  
a transmissão virtual.

Essa distinção é a base técnica e econômica do produto.