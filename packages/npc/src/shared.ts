/**
 * Porta única para @streampolis/shared — a mesma solução do game server: o
 * pacote compartilhado publica .ts cru, e este worker compila o que usa dele
 * no próprio dist. Nenhum outro módulo importa de '@streampolis/shared'.
 */
export * from '../../shared/src/index.js';
