import { useEffect, useState } from 'react';
import { ApiError, type CheckoutIntent, type CoinPackage } from '../network/api.js';
import { useAccountStore } from '../state/useAccountStore.js';
import { short } from '../state/format.js';
import { Button, Money, Notice } from './primitives/Controls.js';
import { IconCoin } from './Icons.js';

/**
 * Comprar Coins (PRD §14, §15).
 *
 * A tela existe para uma frase do PRD: **dinheiro real → Coins → presente**. A
 * API já sabia todo o caminho, e ninguém conseguia percorrê-lo — a carteira de
 * uma conta nova nascia em zero e ficava em zero.
 *
 * ## O que esta tela NÃO faz
 *
 * Não cobra, não credita e não sabe se o pagamento deu certo. Ela abre uma
 * intenção de compra e manda a pessoa para o provedor; quem credita é o webhook
 * do provedor, do outro lado. Isso não é limitação de escopo, é a regra: uma
 * tela que pudesse creditar seria uma impressora de Coins.
 *
 * ## Os três estados que ela precisa contar
 *
 * 1. **sem provedor** (a produção de hoje): a API responde 503 e a tela diz que
 *    a compra ainda não está disponível — não adianta esconder o botão, porque
 *    a pergunta "como consigo Coins?" continua existindo;
 * 2. **provedor de mentira** (`sandbox`, só fora de produção): mostra um botão
 *    de confirmação declarado como teste. Ele está aqui de propósito e não
 *    disfarçado de pagamento real;
 * 3. **provedor de verdade**: abre a URL do checkout e espera a volta. O saldo
 *    aparece quando o webhook chegar, e a tela avisa isso em vez de mentir um
 *    "pronto!" que ela não tem como saber.
 */

const preco = (cents: number, moeda: string) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda || 'BRL' }).format(cents / 100);

export interface CoinShopProps {
  onClose: () => void;
}

export function CoinShop({ onClose }: CoinShopProps) {
  const api = useAccountStore((s) => s.api);
  const wallet = useAccountStore((s) => s.wallet);
  const refresh = useAccountStore((s) => s.refresh);
  const authenticated = useAccountStore((s) => Boolean(s.api?.authenticated));

  const [pacotes, setPacotes] = useState<CoinPackage[] | null>(null);
  const [aviso, setAviso] = useState('');
  const [intencao, setIntencao] = useState<CheckoutIntent | null>(null);
  const [indisponivel, setIndisponivel] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [recado, setRecado] = useState<{ ok: boolean; texto: string } | null>(null);

  useEffect(() => {
    let vivo = true;
    void (api ?? null)?.coinPackages()
      .then((r) => { if (vivo) { setPacotes(r.packages); setAviso(r.disclosure); } })
      .catch(() => { if (vivo) setPacotes([]); });
    return () => { vivo = false; };
  }, [api]);

  const comprar = async (pacote: CoinPackage) => {
    if (!api?.authenticated) return;
    setOcupado(true);
    setIndisponivel(null);
    try {
      const nova = await api.startCheckout(pacote.id);
      setIntencao(nova);
      if (nova.provider !== 'sandbox') {
        // Provedor de verdade: a tela dele é a próxima, e a nossa fica
        // esperando. `noopener` porque a página do provedor não tem nada que
        // fazer com a referência desta janela.
        window.open(nova.checkoutUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      // 503 é a resposta honesta de "não há gateway contratado" — merece a
      // frase da API, não um "erro" genérico.
      setIndisponivel(err instanceof ApiError ? err.message : 'Não foi possível abrir a compra agora.');
    } finally {
      setOcupado(false);
    }
  };

  const confirmarSandbox = async () => {
    if (!api?.authenticated || !intencao) return;
    setOcupado(true);
    try {
      await api.confirmSandboxPayment(intencao.paymentId);
      await refresh();
      setIntencao(null);
      setRecado({ ok: true, texto: 'Coins creditados.' });
    } catch (err) {
      setRecado({ ok: false, texto: err instanceof ApiError ? err.message : 'A confirmação falhou.' });
    } finally {
      setOcupado(false);
      window.setTimeout(() => setRecado(null), 2600);
    }
  };

  return (
    <div className="store__confirm" role="dialog" aria-label="Comprar Coins">
      <div className="store__confirmBox coinshop">
        <header className="coinshop__head">
          <strong>Comprar Coins</strong>
          <Money currency="coins" amount={wallet.coins} icon={<IconCoin size={15} />} />
        </header>

        {!authenticated && (
          <Notice tone="warn">Entre com a sua conta para comprar — Coins vão para uma carteira, e a carteira é de alguém.</Notice>
        )}

        {indisponivel && <Notice tone="warn">{indisponivel}</Notice>}

        {pacotes === null && <p className="coinshop__hint">Carregando pacotes…</p>}
        {pacotes?.length === 0 && !indisponivel && (
          <Notice tone="warn">Nenhum pacote disponível no momento.</Notice>
        )}

        {!intencao && pacotes && pacotes.length > 0 && (
          <ul className="coinshop__list">
            {pacotes.map((p) => (
              <li key={p.id} className="coinshop__pack">
                <div className="coinshop__packInfo">
                  <span className="coinshop__packName">{p.name}</span>
                  <span className="sp-num coinshop__packCoins">
                    <IconCoin size={13} /> {short(p.totalCoins)}
                    {p.bonusCoins > 0 && <em className="coinshop__bonus">+{short(p.bonusCoins)} bônus</em>}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!authenticated || ocupado}
                  onClick={() => void comprar(p)}
                >
                  {preco(p.priceCents, p.currency)}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {intencao && (
          <div className="coinshop__pending">
            <p>
              Compra aberta: <span className="sp-num">{short(intencao.coins)} Coins</span> por{' '}
              <span className="sp-num">{preco(intencao.priceCents, intencao.currency)}</span>.
            </p>
            {intencao.provider === 'sandbox' ? (
              <>
                <Notice tone="warn">
                  Provedor de teste. Nenhum dinheiro é cobrado — este botão existe para exercitar o
                  fluxo fora de produção.
                </Notice>
                <Button variant="primary" disabled={ocupado} onClick={() => void confirmarSandbox()}>
                  {ocupado ? 'Confirmando…' : 'Confirmar pagamento (teste)'}
                </Button>
              </>
            ) : (
              <p className="coinshop__hint">
                Terminamos aqui: conclua o pagamento na aba que abriu. Os Coins aparecem na carteira
                assim que o provedor confirmar.
              </p>
            )}
            <Button variant="ghost" onClick={() => setIntencao(null)}>Escolher outro pacote</Button>
          </div>
        )}

        {aviso && <p className="coinshop__disclosure">{aviso}</p>}

        <div className="store__confirmActions">
          <Button variant="ghost" onClick={onClose}>Fechar</Button>
        </div>

        {recado && (
          <div className={`store__toast${recado.ok ? ' is-ok' : ' is-bad'}`} role="status">{recado.texto}</div>
        )}
      </div>
    </div>
  );
}
