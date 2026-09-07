-- 0020_city_events.sql — eventos da cidade (PRD §22, §28; SPECs §67).
--
-- "Eventos" aparece sete vezes no PRD e uma vez no roadmap técnico, sempre
-- como coisa de outra seção: fonte de fama (§22), conteúdo que o admin
-- administra (§28), o que a Arena existe para sediar (§6), o que uma agência
-- disputa (§19). Nunca teve seção própria — e por isso nunca teve tabela.
--
-- Um evento aqui é uma COMPETIÇÃO COM PRAZO: uma janela de tempo, uma métrica
-- e um pódio. Nada mais.
--
-- ## O placar não mora aqui, e essa é a decisão inteira
--
-- Não existe tabela de pontuação de evento. Não existe contador que sobe a cada
-- presente, a cada live, a cada entrega. O placar é uma CONSULTA sobre os fatos
-- que a cidade já registrava antes de eventos existirem: `gift_events`,
-- `stream_sessions`, `pk_matches`, `gig_runs`, `follows`.
--
-- É a mesma escolha das missões ("progresso é consulta, não contador") e da
-- fama ("derivada, não incrementada"), e ela paga três vezes:
--
--   1. um evento pode ser criado com a janela JÁ CORRENDO, ou até fechada, e o
--      placar sai certo — ninguém perdeu ponto por ter jogado antes de alguém
--      apertar "criar";
--   2. a API pode ficar fora do ar no meio do evento sem que nada se perca:
--      quem estava jogando estava alimentando as tabelas de sempre;
--   3. não há a segunda verdade clássica — "eu mandei o presente e o placar não
--      subiu" —, porque não existe um segundo lugar onde o presente é anotado.
--
-- O que se guarda é só o que NÃO dá para deduzir: que o evento existiu, com que
-- regra, e quem foi pago por ele.
--
-- ## Janelas que se sobrepõem, e por que o banco não proíbe
--
-- Dois eventos de `gifts_sent` ao mesmo tempo fazem o mesmo presente contar nas
-- duas disputas. Expressar "sem sobreposição" em CHECK é impossível; o jeito
-- certo seria `EXCLUDE USING gist (metric WITH =, tstzrange(...) WITH &&)`, que
-- exige a extensão `btree_gist` — ou seja, exige superusuário no boot da
-- migration. Este banco não tem esse direito garantido, e uma migration que
-- morre por permissão é pior do que uma regra na aplicação.
--
-- Então a recusa mora em `CityEvents.createEvent`, onde há um só criador
-- (admin) e nenhuma corrida real. E o dinheiro está protegido de qualquer
-- forma, no lugar que importa: a chave de idempotência do pagamento é
-- `event_<evento>_<pessoa>`, então UM evento paga UMA pessoa UMA vez, mesmo que
-- a apuração rode dez vezes. Sobreposição é um erro de conteúdo, não um vazamento
-- de economia.
CREATE TABLE streampolis.city_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- O nome curto pelo qual a tela e a URL chamam o evento. Único, porque o
  -- jogador vai receber um link para ele.
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  title       TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 60),
  -- A linha que explica por que o evento existe. É o que separa uma competição
  -- de uma planilha com prêmio.
  flavor      TEXT NOT NULL DEFAULT '' CHECK (length(flavor) <= 200),
  -- Qual fato da cidade vira ponto. A lista vive em `CityEvents.ts` — aqui só
  -- se guarda a chave, porque a tradução para SQL é código, não dado.
  metric      TEXT NOT NULL CHECK (metric ~ '^[a-z_]{3,32}$'),
  -- Onde o evento é AMBIENTADO. Não filtra pontuação: um evento de presentes
  -- conta presentes dados em qualquer lugar. Serve para a tela dizer onde a
  -- cidade se junta — e para o dia em que uma cena souber se enfeitar.
  -- NULL = a cidade inteira.
  scene       TEXT,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  -- Credits por colocação: `podium[1]` é o primeiro lugar. Array e não três
  -- colunas porque o tamanho do pódio é decisão de cada evento — um evento de
  -- estreia premia dez, uma final premia dois.
  podium      INTEGER[] NOT NULL CHECK (
                cardinality(podium) BETWEEN 1 AND 20
                AND array_position(podium, NULL) IS NULL
              ),
  -- Abaixo disto ninguém é premiado, por mais alto que esteja na lista. Sem ele
  -- um evento sem participantes premiaria quem passou perto e fez um ponto por
  -- acidente — e o pódio viraria sorteio.
  min_score   BIGINT NOT NULL DEFAULT 1 CHECK (min_score >= 1),
  -- 'scheduled' — marcado ou correndo; 'settled' — apurado e pago;
  -- 'cancelled' — desmarcado antes de apurar, e ninguém recebe.
  status      TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'settled', 'cancelled')),
  created_by  UUID REFERENCES streampolis.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ,
  CHECK (ends_at > starts_at),
  -- Estado encerrado tem data de encerramento; evento em pé, não. A mesma
  -- regra que `gig_runs` carrega, pelo mesmo motivo: um estado que se
  -- contradiz é o que faz um relatório mentir seis meses depois.
  CHECK ((status = 'settled') = (settled_at IS NOT NULL))
);

-- A leitura de sempre: "o que está no ar agora, o que vem, o que acabou".
CREATE INDEX city_events_janela ON streampolis.city_events (ends_at DESC, starts_at DESC);
-- A varredura da apuração preguiçosa: eventos vencidos e ainda não apurados.
CREATE INDEX city_events_a_apurar
  ON streampolis.city_events (ends_at) WHERE status = 'scheduled';

-- O resultado, congelado.
--
-- Aqui SE guarda a pontuação, e não é contradição com o parágrafo de cima: o
-- placar ao vivo é consulta, o RESULTADO é fato histórico. Um evento apurado
-- não pode mudar de vencedor porque alguém apagou a conta, porque um presente
-- foi estornado ou porque a fórmula da métrica mudou no mês seguinte.
CREATE TABLE streampolis.event_awards (
  event_id   UUID NOT NULL REFERENCES streampolis.city_events(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  rank       SMALLINT NOT NULL CHECK (rank >= 1),
  score      BIGINT NOT NULL CHECK (score >= 0),
  credits    INTEGER NOT NULL CHECK (credits >= 0),
  -- A transação que pagou. Sem ela, "premiado e pago" seria palavra nossa.
  -- Nula por um instante: a linha do pódio entra antes do dinheiro sair, de
  -- propósito, para que uma queda no meio deixe rastro do que ficou devendo.
  tx_id      UUID REFERENCES streampolis.wallet_transactions(id),
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- Uma colocação por evento: dois primeiros lugares no mesmo evento é o defeito
-- que uma apuração repetida produziria se ninguém olhasse.
CREATE UNIQUE INDEX event_awards_uma_colocacao ON streampolis.event_awards (event_id, rank);
-- "Quantos pódios esta pessoa fez" — a pergunta que a fama (§22) faz.
CREATE INDEX event_awards_por_pessoa ON streampolis.event_awards (user_id, awarded_at DESC);

-- A alavanca de emergência (SPECs §64). Ligada, porque a feature nasce no ar;
-- desligada, ela para de PAGAR e de aceitar eventos novos — o quadro continua
-- visível, porque esconder o placar de quem está no meio de uma disputa é
-- pânico, não contenção. Entra em `FLAGS_EM_USO`: flag que ninguém lê é o pior
-- tipo de flag, e este arquivo não vai criar uma sétima.
INSERT INTO streampolis.feature_flags (key, enabled, description) VALUES
  ('events_enabled', TRUE, 'Eventos da cidade: criação e pagamento de pódio (PRD §22/§28).')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Um evento de estreia, ancorado no relógio da migration.
--
-- Sem isto a feature sobe invisível: um quadro de eventos vazio, esperando um
-- admin que talvez só apareça semana que vem. Uma semana de "quem mais entrega
-- bicos no Distrito Sombra" usa o bairro que acabou de abrir e não depende de
-- ninguém gastar dinheiro para participar.
INSERT INTO streampolis.city_events (slug, title, flavor, metric, scene, starts_at, ends_at, podium, min_score)
VALUES (
  'semana-de-estreia',
  'Semana de estreia do Distrito Sombra',
  'O bairro abriu e o serviço não para. Quem entregar mais bicos até domingo sobe no letreiro.',
  'gigs_delivered',
  'noir_district',
  date_trunc('hour', now()),
  date_trunc('hour', now()) + INTERVAL '7 days',
  ARRAY[1200, 700, 400, 200, 200, 100, 100, 100, 100, 100],
  3
);
