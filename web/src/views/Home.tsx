import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Environment } from './Environment';

/**
 * The canvas navigator root ('/'): shows the ENVIRONMENT — the org hierarchy
 * (units → projects). Clicking a project drills into its architecture canvas at
 * /canvas/<project> (a refresh-safe, shareable path; Stage J moved navigation
 * out of the ?project= query and engine-internal state into the URL).
 *
 * Legacy shim: an old ?project=<id> (or ?projectId=<id>) link is redirected to
 * the new /canvas/<id> path so existing bookmarks keep working.
 */
export function Home() {
  const [params] = useSearchParams();
  const legacy = params.get('project') ?? params.get('projectId');
  const navigate = useNavigate();

  useEffect(() => {
    if (legacy) navigate('/canvas/' + encodeURIComponent(legacy), { replace: true });
  }, [legacy, navigate]);

  if (legacy) return null; // redirecting to /canvas/<id>
  return <Environment />;
}
