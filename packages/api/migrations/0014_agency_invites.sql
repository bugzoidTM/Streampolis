-- 0014_agency_invites.sql — o convite que faltava para as agências (PRD §19).
--
-- `agencies` e `agency_members` existem desde a 0003, e não havia como uma
-- pessoa entrar numa agência: faltava a etapa do meio. Entrar é um ato de DUAS
-- vontades — a agência chama, a pessoa aceita —, e é isso que esta tabela
-- guarda. Sem ela, ou a agência arrasta gente para dentro, ou qualquer um se
-- inscreve sozinho: as duas coisas transformam "agência" em lista de nomes.
CREATE TABLE streampolis.agency_invites (
  agency_id  UUID NOT NULL REFERENCES streampolis.agencies(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, user_id)
);
CREATE INDEX agency_invites_user_idx ON streampolis.agency_invites (user_id, created_at DESC);
