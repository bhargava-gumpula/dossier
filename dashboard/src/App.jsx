import { useEffect, useState } from 'react';
import Landing from './Landing.jsx';
import Dashboard from './Dashboard.jsx';

// Two surfaces, one bundle. No router dependency for two routes.
export default function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (to) => { window.history.pushState({}, '', to); setPath(to); window.scrollTo(0, 0); };

  return path.startsWith('/app')
    ? <Dashboard onHome={() => go('/')} />
    : <Landing onEnter={() => go('/app')} />;
}
