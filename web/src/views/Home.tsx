import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get } from '../api';
import { useAsync } from '../ui';
import type { ProjectRecord } from '../types';

/** Canvas landing view. The selected project lives in the URL (?project=…) so a
 *  view is a shareable link. When none is selected it defaults to the first
 *  visible project. The full canvas-first navigation (drill-down, up/back,
 *  cross-project relations) builds on this; today it embeds the existing
 *  self-contained canvas for the selected project via the same-origin iframe. */
export function Home() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('project') ?? '';
  const projects = useAsync<{ projects: ProjectRecord[] }>(() => get('/web/projects'), []);
  const list = projects.data?.projects ?? [];

  // Default the URL to the first visible project once loaded and none is chosen.
  useEffect(() => {
    if (!selected && list.length > 0) {
      setParams({ project: list[0].id }, { replace: true });
    }
  }, [selected, list, setParams]);

  return (
    <div className="canvas-view">
      <div className="canvas-bar">
        {list.length > 0 ? (
          <label className="inline-field">
            <span>Project</span>
            <select
              className="input"
              value={selected}
              onChange={(e) => setParams({ project: e.target.value })}
            >
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="hint">No projects in your scope yet.</span>
        )}
      </div>
      {selected ? (
        <iframe
          className="canvas-frame"
          title="Architecture canvas"
          src={`/web/canvas?projectId=${encodeURIComponent(selected)}&_embed=true`}
        />
      ) : (
        <div className="empty-state">
          <h3>Nothing to show yet</h3>
          <p className="hint">Once you can see a project, its architecture canvas appears here.</p>
        </div>
      )}
    </div>
  );
}
