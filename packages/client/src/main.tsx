import { createRoot } from 'react-dom/client';
import type { SceneId } from '@streampolis/shared';
import { AvatarLab } from './lab/AvatarLab.js';
import { WorldView } from './ui/WorldView.js';
import './ui/styles/tokens.css';
import './ui/styles/base.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'world';

const root = createRoot(document.getElementById('root')!);

if (view === 'lab') {
  root.render(<AvatarLab />);
} else {
  // `token` is the dev identity the game server accepts while the API does not
  // mint real ones yet; without it the world runs offline (SPECs §36).
  root.render(
    <WorldView
      sceneId={(params.get('scene') as SceneId | null) ?? 'central_plaza'}
      tier={(params.get('tier') as 'low' | 'medium' | 'high' | null) ?? undefined}
      token={params.get('token') ?? undefined}
      displayName={params.get('name') ?? undefined}
      endpoint={params.get('server') ?? undefined}
    />,
  );
}
