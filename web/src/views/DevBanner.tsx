import { useEffect } from 'react';
import { get } from '../api';
import { useAsync } from '../ui';
import type { DevStatus } from '../types';

/**
 * The local development server's startup banner: one line per member of the family that could not be
 * loaded, with the reason. It is a live read of GET /web/dev/status - refetched when the window regains
 * focus and on every realtime change nudge - so fixing a member on disk clears its line without a restart.
 * A failed read shows no banner and never blocks the app.
 */
export function DevBanner() {
  const status = useAsync<DevStatus>(() => get<DevStatus>('/web/dev/status'), [], ['project:local', 'projects']);
  const { reload } = status;
  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const problems = status.data?.devMode ? status.data.problems : [];
  if (problems.length === 0) return null;
  return (
    <div className="lock-banner dev-banner" role="alert">
      <strong>
        {problems.length === 1 ? '1 member of this project could not be loaded' : problems.length + ' members of this project could not be loaded'}
      </strong>{' '}
      - the rest is served.
      <ul className="dev-banner-list">
        {problems.map((p) => (
          <li key={p.member}>
            <code>{p.member}</code>
            {p.path ? <span className="dim"> ({p.path})</span> : null}: {p.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
