import { useEffect, useState } from 'react';

export function navigate(to: string) {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const on = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return loc;
}
