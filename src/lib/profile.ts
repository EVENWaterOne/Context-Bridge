export interface LocalProfile { name: string; email: string }
const KEY = 'cb-profile';
export function loadProfile(): LocalProfile | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!value || typeof value !== 'object') return null;
    const p = value as Record<string, unknown>;
    return typeof p.name === 'string' && p.name.trim() && typeof p.email === 'string' ? { name: p.name, email: p.email } : null;
  } catch { return null; }
}
export function persistProfile(profile: LocalProfile | null): boolean {
  try { if (profile) localStorage.setItem(KEY, JSON.stringify(profile)); else localStorage.removeItem(KEY); return true; }
  catch { return false; }
}
