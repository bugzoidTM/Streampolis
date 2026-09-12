/** Uma linha por acontecimento, com hora: é o que o `docker service logs` mostra. */
export function log(scope: string, message: string, extra?: Record<string, unknown>): void {
  const when = new Date().toISOString().slice(11, 19);
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`${when} [${scope}] ${message}${tail}`);
}

export function warn(scope: string, message: string, extra?: Record<string, unknown>): void {
  const when = new Date().toISOString().slice(11, 19);
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  console.warn(`${when} [${scope}] ${message}${tail}`);
}
