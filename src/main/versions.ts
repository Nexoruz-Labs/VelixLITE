export interface MinecraftVersion {
  id: string;
  type: string;
  url: string;
  releaseTime: string;
}

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

let cachedVersions: MinecraftVersion[] | null = null;

export async function fetchVersions(): Promise<MinecraftVersion[]> {
  if (cachedVersions) return cachedVersions;

  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error('Failed to fetch version manifest');

  const data = await res.json();
  const latestRelease = data.latest.release;
  const latestSnapshot = data.latest.snapshot;

  const virtual: MinecraftVersion[] = [
    { id: 'latest-release', type: 'latest-release', url: '', releaseTime: '' },
    { id: 'latest-snapshot', type: 'latest-snapshot', url: '', releaseTime: '' },
  ];

  const realVersions: MinecraftVersion[] = data.versions.filter(
    (v: MinecraftVersion) => v.type === 'release' || v.type === 'snapshot'
  );

  cachedVersions = [...virtual, ...realVersions];
  return cachedVersions!;
}

export function resolveLatest(versions: MinecraftVersion[], selectedId: string): string {
  if (selectedId === 'latest-release') {
    const v = versions.find(x => x.type === 'latest-release');
    return v?.id || 'latest-release';
  }
  if (selectedId === 'latest-snapshot') {
    const v = versions.find(x => x.type === 'latest-snapshot');
    return v?.id || 'latest-snapshot';
  }
  return selectedId;
}
