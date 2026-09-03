/**
 * A sessão do jogador no navegador — e quem a mantém viva.
 *
 * O access token dura 15 minutos por decisão de segurança (SPECs §36), e por
 * muito tempo isso foi tudo o que existia: o cliente guardava o token da
 * entrada e o reapresentava para sempre. Quinze minutos depois, a praça
 * respondia `expired` e o jogo caía em "modo offline"; a porta do apartamento,
 * que precisa perguntar à API qual é a casa do jogador, tomava 401 e o
 * devolvia à praça. Dois sintomas, uma causa — e nenhum dos dois dizia a
 * verdade na tela.
 *
 * O que este módulo faz: guarda o PAR (access + refresh), renova sozinho antes
 * do vencimento, e quando não dá mais para renovar declara a sessão PERDIDA em
 * vez de fingir que o servidor sumiu. "Sua sessão expirou" e "o servidor caiu"
 * são coisas diferentes e a interface precisa saber qual das duas aconteceu.
 */

const ACCESS_KEY = 'streampolis.token';
const REFRESH_KEY = 'streampolis.refresh';
const EXPIRES_KEY = 'streampolis.expires';
/** Quem está renovando agora, para as outras abas não renovarem junto. */
const LOCK_KEY = 'streampolis.renovando';

/** Renova com folga: o relógio do navegador não é confiável ao segundo. */
const MARGEM_MS = 90_000;
/** Nunca agendar mais perto do que isto, para não virar laço apertado. */
const MINIMO_MS = 5_000;
/** Quanto tempo uma aba pode segurar a renovação antes de ser ignorada. */
const TRAVA_MS = 10_000;

export interface IssuedSession {
  token: string;
  expiresIn: number;
  refreshToken?: string;
  refreshExpiresIn?: number;
}

type Listener = (token: string | undefined) => void;

function ler(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    // Navegador com armazenamento bloqueado: a sessão dura só esta aba.
    return undefined;
  }
}

function gravar(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* sem persistência; segue em memória */ }
}

function destravar(): void {
  gravar(LOCK_KEY, undefined);
}

function apiBase(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return `${location.protocol}//${location.hostname}:8787`;
}

class AuthSession {
  private access = ler(ACCESS_KEY);
  private refresh = ler(REFRESH_KEY);
  /** Quando o access vence, em ms epoch. 0 = desconhecido. */
  private expiresAt = Number(ler(EXPIRES_KEY) ?? 0) || 0;
  private timer: number | undefined;
  private renewing: Promise<string | undefined> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor() {
    // Sessão de antes do refresh existir: access solto, sem par. Ele não
    // renova e provavelmente já venceu — melhor pedir a entrada de novo do que
    // deixar o jogador num mundo offline sem explicação.
    if (this.access && !this.refresh) this.esquecer();
    this.agendar();
    if (typeof document !== 'undefined') {
      // Uma aba em segundo plano não roda `setTimeout` no horário; ao voltar,
      // o token pode ter vencido enquanto ninguém olhava.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.assegurar();
      });
    }
    if (typeof window !== 'undefined') {
      // A sessão é do NAVEGADOR, não da aba. Quando uma aba renova, as outras
      // adotam o par novo em vez de apresentarem o antigo — que o servidor
      // leria como reúso e derrubaria a família das duas.
      window.addEventListener('storage', (e) => {
        if (e.key !== ACCESS_KEY && e.key !== REFRESH_KEY) return;
        this.relerDoArmazenamento();
      });
    }
  }

  /** Adota o que outra aba gravou. */
  private relerDoArmazenamento(): void {
    const access = ler(ACCESS_KEY);
    const refresh = ler(REFRESH_KEY);
    if (access === this.access && refresh === this.refresh) return;
    this.access = access;
    this.refresh = refresh;
    this.expiresAt = Number(ler(EXPIRES_KEY) ?? 0) || 0;
    this.agendar();
    this.avisar();
  }

  get token(): string | undefined {
    return this.access;
  }

  /** Já venceu (ou está a menos de um respiro de vencer)? */
  get vencido(): boolean {
    if (!this.access) return true;
    if (!this.expiresAt) return false;
    return Date.now() >= this.expiresAt;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Adota o par que a API acabou de emitir (entrada ou renovação). */
  adopt(session: IssuedSession): void {
    this.access = session.token;
    this.expiresAt = Date.now() + Math.max(session.expiresIn, 0) * 1000;
    gravar(ACCESS_KEY, this.access);
    gravar(EXPIRES_KEY, String(this.expiresAt));
    if (session.refreshToken) {
      this.refresh = session.refreshToken;
      gravar(REFRESH_KEY, this.refresh);
    }
    this.agendar();
    this.avisar();
  }

  /**
   * Um access novo sem refresh novo — é o que `/me/avatar` devolve ao salvar o
   * look, porque a aparência vai ASSINADA dentro do token. A sessão continua a
   * mesma; só o snapshot mudou.
   */
  adoptAccess(token: string, expiresIn: number): void {
    this.adopt({ token, expiresIn });
  }

  /**
   * Garante um access válido AGORA. Devolve `undefined` quando a sessão acabou
   * de verdade — e nesse caso ela já foi esquecida e os ouvintes, avisados.
   */
  async assegurar(): Promise<string | undefined> {
    if (this.access && !this.vencido) return this.access;
    return this.renovar();
  }

  /**
   * Rotaciona o refresh. Chamadas concorrentes compartilham a MESMA promessa:
   * duas renovações em paralelo apresentariam o mesmo refresh duas vezes, e a
   * segunda seria lida pelo servidor como reúso — que derruba a sessão inteira.
   */
  renovar(): Promise<string | undefined> {
    if (this.renewing) return this.renewing;
    if (!this.refresh) {
      this.esquecer();
      return Promise.resolve(undefined);
    }
    this.renewing = this.renovarAgora().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  private async renovarAgora(): Promise<string | undefined> {
    // Outra aba pode ter renovado enquanto esta dormia: o evento `storage` só
    // avisa quem NÃO gravou, e uma aba que acabou de acordar já o perdeu. Ler
    // antes de pedir evita apresentar um refresh que já morreu.
    this.relerDoArmazenamento();
    if (this.access && !this.vencido) return this.access;

    // Uma aba de cada vez. Sem isto, duas abas apresentam o MESMO refresh, a
    // segunda é lida como reúso, e o servidor derruba as duas — que é o
    // oposto do que a rotação existe para proteger.
    const dono = await this.travar();
    if (!dono) {
      const alheio = await this.esperarOutraAba();
      if (alheio) return alheio;
      // A outra aba não publicou nada (fechou no meio, ficou sem rede). A
      // trava expira sozinha; daqui a sessão segue por conta própria.
    }

    const refreshToken = this.refresh;
    if (!refreshToken) {
      this.esquecer();
      return undefined;
    }

    try {
      const res = await fetch(`${apiBase()}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.status === 401) {
        // O servidor recusou o refresh: acabou mesmo. Insistir só repetiria a
        // recusa, e um refresh já rotacionado derruba a família.
        this.esquecer();
        return undefined;
      }
      if (!res.ok) {
        // Falha de rede ou servidor fora: a sessão NÃO acabou. Tenta de novo
        // mais tarde em vez de expulsar quem ainda tem crachá válido.
        this.reagendar(30_000);
        return undefined;
      }
      const body = (await res.json()) as IssuedSession;
      this.adopt(body);
      return body.token;
    } catch {
      this.reagendar(30_000);
      return undefined;
    } finally {
      // Só quem pegou a trava a devolve: soltar a trava alheia deixaria duas
      // abas renovando ao mesmo tempo, que é o que ela existe para impedir.
      if (dono) destravar();
    }
  }

  /** Sair: revoga no servidor (melhor esforço) e limpa aqui. */
  async logout(): Promise<void> {
    const refreshToken = this.refresh;
    this.esquecer();
    if (!refreshToken) return;
    await fetch(`${apiBase()}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }

  /** A sessão acabou. Ninguém mais tem token, e a interface é avisada. */
  esquecer(): void {
    this.access = undefined;
    this.refresh = undefined;
    this.expiresAt = 0;
    gravar(ACCESS_KEY, undefined);
    gravar(REFRESH_KEY, undefined);
    gravar(EXPIRES_KEY, undefined);
    destravar();
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.avisar();
  }

  /**
   * Tenta ser a aba que renova. Devolve `false` quando outra pegou primeiro.
   *
   * A trava é uma linha no `localStorage` com hora — não há mutex entre abas —
   * e ela EXPIRA: uma aba fechada no meio da renovação não pode trancar a
   * sessão para sempre.
   */
  private async travar(): Promise<boolean> {
    const agora = Date.now();
    const atual = Number(ler(LOCK_KEY) ?? 0) || 0;
    if (atual && agora - atual < TRAVA_MS) return false;
    gravar(LOCK_KEY, String(agora));
    // Duas abas podem gravar no mesmo instante; a última a escrever ganha, e
    // uma pausa curta faz as duas concordarem sobre quem foi.
    await new Promise((r) => setTimeout(r, 40));
    return ler(LOCK_KEY) === String(agora);
  }

  /** Espera a aba que ganhou a trava publicar o par novo. */
  private async esperarOutraAba(): Promise<string | undefined> {
    const antigo = this.access;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      this.relerDoArmazenamento();
      if (this.access && this.access !== antigo && !this.vencido) return this.access;
    }
    return undefined;
  }

  private agendar(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.access || !this.refresh || !this.expiresAt) return;
    this.reagendar(this.expiresAt - Date.now() - MARGEM_MS);
  }

  private reagendar(ms: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.renovar(); }, Math.max(ms, MINIMO_MS));
  }

  private avisar(): void {
    for (const listener of this.listeners) listener(this.access);
  }
}

/** Uma sessão por aba. */
export const authSession = new AuthSession();
