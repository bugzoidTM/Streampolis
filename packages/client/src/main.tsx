import { createRoot } from 'react-dom/client';
import { AvatarLab } from './lab/AvatarLab.js';
import { WorldView } from './ui/WorldView.js';
import { intentFromQuery } from './network/session.js';
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
  const token = params.get('token') ?? undefined;
  root.render(
    <WorldView
      intent={intentFromQuery(params, Boolean(token))}
      tier={(params.get('tier') as 'low' | 'medium' | 'high' | null) ?? undefined}
      token={token}
      displayName={params.get('name') ?? undefined}
      endpoint={params.get('server') ?? undefined}
    />,
  );
}
