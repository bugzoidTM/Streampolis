import { createRoot } from 'react-dom/client';
import { AvatarLab } from './lab/AvatarLab.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'lab';

const root = createRoot(document.getElementById('root')!);
root.render(view === 'lab' ? <AvatarLab /> : <AvatarLab />);
