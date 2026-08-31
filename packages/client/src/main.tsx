import { createRoot } from 'react-dom/client';
import { AvatarLab } from './lab/AvatarLab.js';
import { AppShell } from './ui/AppShell.js';
import { intentFromQuery } from './network/session.js';
import { savedToken } from './ui/EnterScreen.js';
import './ui/styles/tokens.css';
import './ui/styles/base.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'world';

const root = createRoot(document.getElementById('root')!);

if (view === 'lab') {
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
