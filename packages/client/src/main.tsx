import { createRoot } from 'react-dom/client';
import { AvatarLab } from './lab/AvatarLab.js';
import { AssetLab } from './lab/AssetLab.js';
import { AppShell } from './ui/AppShell.js';
import { intentFromQuery } from './network/session.js';
import { savedToken } from './ui/EnterScreen.js';
import './ui/styles/tokens.css';
import './ui/styles/base.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'world';

const root = createRoot(document.getElementById('root')!);

if (view === 'assets') {
  root.render(<AssetLab />);
} else if (view === 'lab') {
  root.render(<AvatarLab />);
} else {
  // A URL diz a INTENÇÃO, não a sala: `?watch=<roomId>` assiste, `?golive=1`
  // transmite, `?apartment=me` abre a própria casa, `?scene=` escolhe a área
  // pública. Sem `?token=` nada disso vale e o mundo roda offline (SPECs §36).
  // A URL manda (link direto para uma live, ferramenta de captura); depois
  // dela, a sessão da última visita.
  const token = params.get('token') ?? savedToken();
  root.render(
    <AppShell
      intent={intentFromQuery(params, Boolean(token))}
      tier={(params.get('tier') as 'low' | 'medium' | 'high' | null) ?? undefined}
      token={token}
      displayName={params.get('name') ?? undefined}
      endpoint={params.get('server') ?? undefined}
    />,
  );
}

/**
 * Apaga a tela de arranque do `index.html`.
 *
 * Ela cobriu a espera pelo bundle; daqui em diante quem informa é a tela de
 * carregamento do jogo, que mede coisa real. A saída espera DOIS quadros: o
 * React 18 pinta depois do `render()`, e remover no mesmo instante devolve um
 * lampejo de página vazia entre as duas telas — o piscado que a tela de
 * arranque existe para não haver.
 */
requestAnimationFrame(() => requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('boot--out');
  boot.addEventListener('transitionend', () => boot.remove(), { once: true });
  // Rede de segurança: uma aba em segundo plano não roda transição, e a tela
  // de arranque ficaria por cima do jogo para sempre.
  window.setTimeout(() => boot.remove(), 1200);
}));
