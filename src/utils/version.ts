// ---------------------------------------------------------------------------
// Version comparison (semver-lite, handles X.Y.Z and X.Y.Z-suffix.N)
//
// Shared by the self-update check (is a newer release available?) and the pack
// store (which installed version is the latest?). Deliberately dependency-free:
// wairon ships as a standalone binary, and a full semver implementation is not
// worth a dependency for comparing X.Y.Z with an optional pre-release suffix.
//
// NOT supported by design: ranges (^1.2.0, ~1.2). Pack selections are an exact
// pin or "latest installed" — see docs/design/pack-scoping.md.
// ---------------------------------------------------------------------------

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewerVersion(current: string, candidate: string): boolean {
  // Strip pre-release suffix for base version comparison
  const baseVersion = (v: string) => v.replace(/-.*$/, '');
  const preRelease = (v: string) => {
    const match = v.match(/-(.+)\.(\d+)$/);
    return match ? { label: match[1], n: parseInt(match[2], 10) } : null;
  };

  const parse = (v: string) => baseVersion(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [cMaj, cMin, cPat] = parse(current);
  const [nMaj, nMin, nPat] = parse(candidate);

  if (nMaj !== cMaj) return nMaj > cMaj;
  if (nMin !== cMin) return nMin > cMin;
  if (nPat !== cPat) return nPat > cPat;

  // Same base version: stable > pre-release; higher pre-release N wins
  const cPre = preRelease(current);
  const nPre = preRelease(candidate);

  if (!cPre && !nPre) return false;    // same stable
  if (!cPre && nPre) return false;     // current stable, candidate is pre-release — not newer
  if (cPre && !nPre) return true;      // current pre-release, candidate stable — stable wins
  if (cPre && nPre) return nPre.n > cPre.n; // both pre-release, higher N wins

  return false;
}
