import { useEffect, useState } from 'react';
import { get } from '../api';

interface ProjectRecord {
  id: string;
  status: string;
}

/** Interim landing view for the foundation milestone: lists the caller's
 *  visible projects and embeds the existing self-contained architecture canvas
 *  for the selected one via the same /web/canvas iframe the previous UI used.
 *  This is replaced by the canvas-first navigation in a later phase. */
export function Home() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [err, setErr] = useState('');

  useEffect(() => {
    get<{ projects: ProjectRecord[] }>('/web/projects')
      .then((d) => {
        const list = d.projects ?? [];
        setProjects(list);
        setSelected((s) => s || (list[0]?.id ?? ''));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="home">
      <div className="home-bar">
        {projects.length > 0 ? (
          <label>
            Project&nbsp;
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {projects.map((p) => (
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
      {err && <p className="err">{err}</p>}
      {selected ? (
        <iframe
          className="canvas-frame"
          title="Architecture canvas"
          src={`/web/canvas?projectId=${encodeURIComponent(selected)}`}
        />
      ) : (
        <div className="empty">
          <h3>Nothing to show yet</h3>
          <p className="hint">Once you can see a project, its architecture canvas appears here.</p>
        </div>
      )}
    </div>
  );
}
