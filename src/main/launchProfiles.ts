export type ProfileId = 'emergency' | 'potato' | 'potatopp' | 'godpotato';

export interface LaunchProfile {
  id: ProfileId;
  label: string;
  icon: string;
  description: string;
  tooltip: string;
  minRAM: number;
  maxRAM: number;
  scaleFactor: number;
  xms: number;
  jvmArgs: string[];
  processPriority: 'low' | 'normal' | 'high';
  closeAfterLaunch: boolean;
  reuseCaches: boolean;
  skipVerification: boolean;
}

const PROFILES: Record<ProfileId, Omit<LaunchProfile, 'minRAM' | 'maxRAM' | 'scaleFactor' | 'xms'>> = {
  emergency: {
    id: 'emergency',
    label: 'Emergency Potato',
    icon: '🪫',
    description: 'Optimized for low-end PCs',
    tooltip: 'Minimal RAM, lightweight GC, low priority. For 4-8 GB systems with weak GPUs.',
    jvmArgs: [
      '-XX:+UseSerialGC',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+AlwaysPreTouch',
      '-XX:+DisableExplicitGC',
      '-XX:-UseG1GC',
      '-XX:-UseParallelGC',
      '-XX:MaxGCPauseMillis=50',
    ],
    processPriority: 'normal',
    closeAfterLaunch: true,
    reuseCaches: true,
    skipVerification: true,
  },
  potato: {
    id: 'potato',
    label: 'Potato',
    icon: '🥔',
    description: 'Recommended',
    tooltip: 'Balanced profile. Stable JVM args, normal priority, automatic settings.',
    jvmArgs: [
      '-XX:+UseG1GC',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:MaxGCPauseMillis=100',
      '-XX:G1HeapRegionSize=4M',
      '-XX:+ParallelRefProcEnabled',
    ],
    processPriority: 'normal',
    closeAfterLaunch: false,
    reuseCaches: false,
    skipVerification: false,
  },
  potatopp: {
    id: 'potatopp',
    label: 'Potato++',
    icon: '🥔🥔',
    description: 'Higher performance',
    tooltip: 'Optimized G1GC, high priority, faster startup. For systems with 8+ GB RAM.',
    jvmArgs: [
      '-XX:+UseG1GC',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1HeapRegionSize=4M',
      '-XX:+ParallelRefProcEnabled',
      '-XX:+AlwaysPreTouch',
      '-XX:-UseAdaptiveSizePolicy',
    ],
    processPriority: 'high',
    closeAfterLaunch: false,
    reuseCaches: true,
    skipVerification: false,
  },
  godpotato: {
    id: 'godpotato',
    label: 'God Potato',
    icon: '👑',
    description: 'Maximum launcher optimizations',
    tooltip: 'Best GC, highest RAM, high priority, maximum caching. Best Java runtime.',
    jvmArgs: [
      '-XX:+UseZGC',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:MaxGCPauseMillis=10',
      '-XX:+ParallelRefProcEnabled',
      '-XX:+AlwaysPreTouch',
      '-XX:+DisableExplicitGC',
      '-XX:-UseAdaptiveSizePolicy',
    ],
    processPriority: 'high',
    closeAfterLaunch: true,
    reuseCaches: true,
    skipVerification: true,
  },
};

export function getProfile(id: ProfileId): LaunchProfile {
  const base = PROFILES[id];
  return {
    ...base,
    minRAM: 512,
    maxRAM: 8192,
    scaleFactor: 0.25,
    xms: 256,
  };
}

export function resolveProfile(id: ProfileId, systemRamBytes: number): LaunchProfile {
  const base = getProfile(id);
  const systemRamMB = Math.floor(systemRamBytes / 1024 / 1024);
  const scaledMax = Math.floor(systemRamMB * base.scaleFactor);
  const clampedMax = Math.max(base.minRAM, Math.min(scaledMax, base.maxRAM));
  const roundedMax = roundDownToNearestPowerOfTwo(clampedMax);
  const xmsVal = Math.min(base.xms, roundedMax);

  switch (id) {
    case 'emergency':
      return {
        ...base,
        maxRAM: Math.min(roundedMax, 2048),
        minRAM: 512,
        xms: 256,
      };
    case 'potato':
      return {
        ...base,
        maxRAM: roundedMax,
        minRAM: Math.min(512, roundedMax),
        xms: xmsVal,
      };
    case 'potatopp':
      return {
        ...base,
        maxRAM: Math.min(roundedMax, 6144),
        minRAM: Math.min(1024, roundedMax),
        xms: xmsVal,
      };
    case 'godpotato':
      return {
        ...base,
        maxRAM: Math.min(roundedMax, 8192),
        minRAM: Math.min(2048, roundedMax),
        xms: xmsVal,
      };
  }
}

function roundDownToNearestPowerOfTwo(n: number): number {
  if (n <= 0) return 512;
  const p = Math.pow(2, Math.floor(Math.log2(n)));
  return Math.max(512, p);
}

export { PROFILES };
