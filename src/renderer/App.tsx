import React, { useEffect, useState, useCallback, useRef } from 'react';
import logo from '../../assets/icon.png';

declare global {
  interface Window {
    velix: {
      getSettings: () => Promise<any>;
      saveSettings: (s: any) => Promise<boolean>;
      loginMicrosoft: () => Promise<any>;
      logoutMicrosoft: () => Promise<boolean>;
      getAccount: () => Promise<any>;
      getVersions: () => Promise<any[]>;
      launchMinecraft: (v: string, account?: any) => Promise<any>;
      onStatus: (cb: (s: string) => void) => void;
      onProgress: (cb: (p: number) => void) => void;
      onLaunchLog: (cb: (l: string) => void) => void;
      onDone: (cb: () => void) => void;
      removeAllListeners: (ch: string) => void;
      minimizeWindow: () => void;
      closeWindow: () => void;
      openExternal: (url: string) => Promise<void>;
      openDonationWindow: (url: string) => Promise<void>;
      getAccounts: () => Promise<StoredAccount[]>;
      addAccount: (a: StoredAccount) => Promise<{ success: boolean; error?: string }>;
      removeAccount: (id: string) => Promise<boolean>;
      getSystemRam: () => Promise<number>;
      getCurrentResolution: () => Promise<{ width: number; height: number }>;
      validateResolution: (w: number, h: number) => Promise<boolean>;
      detectJava: () => Promise<Array<{ version: number; path: string; source: string; isJdk: boolean; displayName: string }>>;
    };
  }
}

interface StoredAccount {
  id: string;
  type: 'microsoft' | 'offline';
  username: string;
  uuid?: string;
}

interface MinecraftVersion {
  id: string;
  type: string;
}

interface Settings {
  gameDirectory: string;
  javaPath: string;
  ram: number;
  resolutionWidth: number;
  resolutionHeight: number;
  displayMode: 'windowed' | 'fullscreen' | 'borderless';
  closeAfterLaunch: boolean;
  jvmArgs: string;
  forceDisplayResolution: boolean;
  fullscreenResWidth: number;
  fullscreenResHeight: number;
  autoInstallJava: boolean;
  lastVersion: string;
  lastAccountId: string;
  launchProfile: string;
}

const RAM_PRESETS = [512, 1024, 2048, 4096, 6144, 8192, 12288];
const formatRamLabel = (mb: number) => `${mb} MB (${mb / 1024} GB)`;

const LAUNCH_PROFILES = [
  { id: 'emergency', icon: '🪫', label: 'Emergency Potato', desc: 'Optimized for low-end PCs' },
  { id: 'potato', icon: '🥔', label: 'Potato', desc: 'Recommended' },
  { id: 'potatopp', icon: '🥔🥔', label: 'Potato++', desc: 'Higher performance' },
  { id: 'godpotato', icon: '👑', label: 'God Potato', desc: 'Maximum launcher optimizations' },
];

function App() {
  const [storedAccounts, setStoredAccounts] = useState<StoredAccount[]>([]);
  const [currentAccount, setCurrentAccount] = useState<StoredAccount | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [offlineName, setOfflineName] = useState('Player');
  const [versions, setVersions] = useState<MinecraftVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [launching, setLaunching] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [progress, setProgress] = useState(0);
  const [launchLog, setLaunchLog] = useState('');
  const [hasError, setHasError] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showOfflineForm, setShowOfflineForm] = useState(false);
  const [newOfflineName, setNewOfflineName] = useState('');
  const [showDonation, setShowDonation] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [donated, setDonated] = useState(false);
  const [systemRam, setSystemRam] = useState(8 * 1024 * 1024 * 1024);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [showCustomRam, setShowCustomRam] = useState(false);
  const [customRamInput, setCustomRamInput] = useState(2048);
  const [activeAdvTab, setActiveAdvTab] = useState('display');
  const [versionSearch, setVersionSearch] = useState('');
  interface JavaInstall { version: number; path: string; source: string; isJdk: boolean; displayName: string; }
  const [javaInstalls, setJavaInstalls] = useState<JavaInstall[]>([]);
  const [settings, setSettings] = useState<Settings>({
    gameDirectory: '',
    javaPath: 'java',
    ram: 2048,
    resolutionWidth: 854,
    resolutionHeight: 480,
    displayMode: 'windowed',
    closeAfterLaunch: false,
    jvmArgs: '',
    forceDisplayResolution: false,
    fullscreenResWidth: 1920,
    fullscreenResHeight: 1080,
    autoInstallJava: true,
    lastVersion: 'latest-release',
    lastAccountId: '',
    launchProfile: 'potato',
  });
  const settingsRef = useRef(settings);

  const logRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    window.velix.getSettings().then((s: Settings) => {
      if (s) {
        setSettings(s);
        if (s.lastVersion) setSelectedVersion(s.lastVersion);
        if (s.lastAccountId) setSelectedAccountId(s.lastAccountId);
      }
    });
    window.velix.getSystemRam().then((bytes: number) => setSystemRam(bytes));
    loadAccounts();
    refreshVersions();

    window.velix.onStatus((s: string) => setStatus(s));
    window.velix.onProgress((p: number) => setProgress(p));
    window.velix.onLaunchLog((l: string) => {
      const upper = l.toUpperCase();
      if (upper.includes('[ERROR]') || upper.includes('FATAL') || upper.includes(' EXCEPTION:') || upper.includes('FAILED TO') || upper.includes('ERROR:')) {
        setHasError(true);
      }
      setLaunchLog(prev => (prev + '\n' + l).slice(-10000));
    });
    window.velix.onDone(() => {
      setLaunching(false);
      if (settingsRef.current.closeAfterLaunch) {
        window.velix.closeWindow();
      }
    });

    const handleClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
        setShowOfflineForm(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => {
      window.velix.removeAllListeners('velix:status');
      window.velix.removeAllListeners('velix:progress');
      window.velix.removeAllListeners('velix:launchLog');
      window.velix.removeAllListeners('velix:done');
      document.removeEventListener('mousedown', handleClick);
    };
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [launchLog, autoScroll]);

  const handleLogScroll = useCallback(() => {
    if (logRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logRef.current;
      setAutoScroll(scrollHeight - scrollTop - clientHeight < 30);
    }
  }, []);

  const clearLog = useCallback(() => {
    setLaunchLog('');
    setHasError(false);
    setAutoScroll(true);
  }, []);

  const renderLogLine = useCallback((line: string, idx: number) => {
    const trimmed = line.trim();
    const isLink = /^https?:\/\//.test(trimmed);
    const upper = line.toUpperCase();
    let cls = '';
    if (upper.includes('[ERROR]') || upper.includes('FATAL') || upper.includes(' EXCEPTION:') || upper.includes('FAILED TO')) {
      cls = 'log-error';
    } else if (upper.includes('[WARN]') || upper.includes('WARNING')) {
      cls = 'log-warn';
    } else if (upper.includes('SUCCESS') || upper.includes('SUCCESSFULLY')) {
      cls = 'log-success';
    }
    if (isLink) {
      return (
        <a
          key={idx}
          href="#"
          className={'log-link' + (cls ? ' ' + cls : '')}
          onClick={e => {
            e.preventDefault();
            window.velix.openExternal(trimmed);
          }}
        >
          {line}
        </a>
      );
    }
    return <div key={idx} className={cls || 'log-info'}>{line}</div>;
  }, []);

  const loadAccounts = async () => {
    const accounts = await window.velix.getAccounts();
    setStoredAccounts(accounts);
  };

  useEffect(() => {
    if (storedAccounts.length > 0 && selectedAccountId) {
      const found = storedAccounts.find(a => a.id === selectedAccountId);
      if (found) {
        setCurrentAccount(found);
        return;
      }
      setSelectedAccountId('');
    }
    if (storedAccounts.length > 0 && !selectedAccountId) {
      setSelectedAccountId(storedAccounts[0].id);
    }
  }, [storedAccounts, selectedAccountId]);

  const refreshVersions = useCallback(async () => {
    try {
      const v = await window.velix.getVersions();
      setVersions(v || []);
      if (v && v.length > 0 && !selectedVersion) {
        const latest = v.find((x: MinecraftVersion) => x.id === 'latest-release') || v[0];
        setSelectedVersion(latest.id);
      }
    } catch {
      const fallback = [
        { id: 'latest-release', type: 'release' },
        { id: 'latest-snapshot', type: 'snapshot' },
        { id: '1.20.6', type: 'release' },
        { id: '1.20.4', type: 'release' },
        { id: '1.19.4', type: 'release' },
        { id: '1.18.2', type: 'release' },
        { id: '1.16.5', type: 'release' },
        { id: '1.12.2', type: 'release' },
        { id: '1.8.9', type: 'release' },
      ];
      setVersions(fallback);
      if (!selectedVersion) setSelectedVersion('latest-release');
    }
  }, [selectedVersion]);

  const handleSelectAccount = (id: string) => {
    setSelectedAccountId(id);
    const found = storedAccounts.find(a => a.id === id);
    setCurrentAccount(found || null);
    saveSetting('lastAccountId', id);
  };

  const handleMicrosoftLogin = async () => {
    setShowAddMenu(false);
    const result = await window.velix.loginMicrosoft();
    if (result.success) {
      const acct = result.account;
      acct.id = 'ms_' + Date.now();
      const addResult = await window.velix.addAccount(acct);
      if (addResult.success) {
        await loadAccounts();
        setSelectedAccountId(acct.id);
        setCurrentAccount(acct);
        saveSetting('lastAccountId', acct.id);
      } else {
        setStatus(addResult.error || 'Failed to save account');
      }
    } else {
      setStatus('Login failed: ' + result.error);
    }
  };

  const handleOfflineSave = async () => {
    const name = (newOfflineName || offlineName).trim() || 'Player';
    if (!name.trim()) return;
    setShowAddMenu(false);
    setShowOfflineForm(false);
    const acct: StoredAccount = {
      id: 'offline_' + Date.now(),
      type: 'offline',
      username: name,
    };
    const result = await window.velix.addAccount(acct);
    if (result.success) {
      setOfflineName('');
      setNewOfflineName('');
      await loadAccounts();
      setSelectedAccountId(acct.id);
      setCurrentAccount(acct);
      saveSetting('lastAccountId', acct.id);
    } else {
      setStatus(result.error || 'Failed to add account');
    }
  };

  const handleRemoveAccount = async () => {
    if (!currentAccount) return;
    await window.velix.removeAccount(currentAccount.id);
    setCurrentAccount(null);
    setSelectedAccountId('');
    await loadAccounts();
  };

  const saveSetting = useCallback((key: keyof Settings, value: any) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      window.velix.saveSettings(next);
      return next;
    });
  }, []);

  const handlePlay = async () => {
    if (!selectedVersion) return;
    setLaunching(true);
    setHasError(false);
    setProgress(0);
    setLaunchLog('');
    setStatus('Starting...');
    const result = await window.velix.launchMinecraft(selectedVersion, currentAccount);
    if (result && result.success === false) {
      setHasError(true);
    }
  };

  const formatVersion = (v: MinecraftVersion) => {
    if (v.type === 'latest-release' || v.id === 'latest-release') return 'Latest Release';
    if (v.type === 'latest-snapshot' || v.id === 'latest-snapshot') return 'Latest Snapshot';
    const prefix = v.type === 'snapshot' ? 'Snapshot' : 'Release';
    return `${prefix} ${v.id}`;
  };

  const openDonation = () => {
    setShowDonation(true);
    setShowConfirmDialog(false);
  };

  const closeDonation = () => {
    setShowDonation(false);
  };

  const handleConfirmBack = () => {
    setShowConfirmDialog(true);
  };

  const handleConfirmReturn = () => {
    setShowConfirmDialog(false);
    setShowDonation(false);
  };

  const handleConfirmDonated = () => {
    setDonated(true);
    setShowConfirmDialog(false);
    setShowDonation(false);
  };

  const handleConfirmContinue = () => {
    setShowConfirmDialog(false);
  };



  return (
    <div className="app-window">
      <div className="title-bar">
        <div className="title-bar-drag">
          <img src={logo} className="title-bar-icon" alt="" />
          <div className="title-bar-text">
            <div className="title">VelixLITE</div>
            <div className="subtitle">Lightweight Minecraft Launcher</div>
          </div>
        </div>
        <div className="title-bar-controls">
          <button className="win-btn win-btn-min" onClick={() => window.velix.minimizeWindow()} aria-label="Minimize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="8" width="8" height="1.4" fill="#5C3E12" /></svg>
          </button>
          <button className="win-btn win-btn-close" onClick={() => window.velix.closeWindow()} aria-label="Close">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="1" y1="1" x2="9" y2="9" stroke="#FFFFFF" strokeWidth="1.6" />
              <line x1="9" y1="1" x2="1" y2="9" stroke="#FFFFFF" strokeWidth="1.6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="main-content" style={{ position: 'relative' }}>
        <div className="donation-overlay" style={{ display: showDonation ? 'flex' : 'none' }}>
          <div className="donation-header">
            <button className="btn" onClick={handleConfirmBack}>← Back</button>
            <div className="donation-title">Support VelixLITE</div>
          </div>
          <div className="donation-body">
            <div className="donation-text">
              Love the launcher? Consider supporting development!
            </div>
            <button className="paypal-btn" onClick={() => window.velix.openDonationWindow('https://www.paypal.com/ncp/payment/LA2K2EZBALT5S')}>
              Donate with PayPal
            </button>
            <div style={{ textAlign: 'center', marginTop: 4 }}>
              <img src="https://www.paypalobjects.com/images/Debit_Credit_APM.svg" alt="cards" style={{ maxWidth: 180 }} />
              <div style={{ fontSize: '0.65rem', color: '#7A5A22', marginTop: 4 }}>
                Powered by <img src="https://www.paypalobjects.com/paypal-ui/logos/svg/paypal-wordmark-color.svg" alt="PayPal" style={{ height: '0.75rem', verticalAlign: 'middle' }} />
              </div>
            </div>
            <div className="donation-note">
              A secure payment window will open within the app.
            </div>
          </div>
        </div>
        <div className="left-panel" style={showDonation ? { visibility: 'hidden' } : undefined}>
          <div className="group-box" style={{ marginTop: 0 }}>
            <div className="group-box-label">Account</div>
            <div className="form-group">
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                <select
                  value={selectedAccountId}
                  onChange={e => handleSelectAccount(e.target.value)}
                  disabled={launching}
                  style={{ flex: 1 }}
                >
                  <option value="">-- Select Account --</option>
                  {storedAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.username} ({a.type === 'microsoft' ? 'MS' : 'Offline'})
                    </option>
                  ))}
                </select>
                <div style={{ position: 'relative' }} ref={addMenuRef}>
                  <button className="btn" onClick={() => setShowAddMenu(!showAddMenu)} disabled={launching} style={{ fontSize: 14, fontWeight: 700, padding: '2px 8px' }}>+</button>
                  {showAddMenu && !showOfflineForm && (
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: 2,
                      background: '#FFFDF7', border: '1px solid #C7A35C', borderRadius: 3,
                      boxShadow: '0 2px 6px rgba(0,0,0,0.15)', zIndex: 10, minWidth: 150,
                    }}>
                      <button className="btn" onClick={handleMicrosoftLogin} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderRadius: 0, borderBottom: '1px solid #E4CB8E', background: 'transparent' }}>
                        Microsoft Login
                      </button>
                      <button className="btn" onClick={() => { setShowOfflineForm(true); setNewOfflineName(''); }} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderRadius: 0, background: 'transparent' }}>
                        Offline Account
                      </button>
                    </div>
                  )}
                  {showAddMenu && showOfflineForm && (
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: 2,
                      background: '#FFFDF7', border: '1px solid #C7A35C', borderRadius: 3,
                      boxShadow: '0 2px 6px rgba(0,0,0,0.15)', zIndex: 10, minWidth: 200, padding: 6,
                    }}>
                      <div style={{ marginBottom: 4 }}>
                        <label>Enter username:</label>
                        <input type="text" value={newOfflineName} onChange={e => setNewOfflineName(e.target.value)} autoFocus style={{ width: '100%', marginTop: 2 }}
                          onKeyDown={e => { if (e.key === 'Enter') handleOfflineSave(); if (e.key === 'Escape') { setShowOfflineForm(false); setShowAddMenu(false); } }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button className="btn" onClick={() => { setShowOfflineForm(false); setShowAddMenu(false); }}>Cancel</button>
                        <button className="btn btn-primary" onClick={handleOfflineSave}>Create</button>
                      </div>
                    </div>
                  )}
                </div>
                {currentAccount && (
                  <button className="btn" onClick={handleRemoveAccount} disabled={launching} style={{ color: '#A02E24' }}>X</button>
                )}
              </div>
              {currentAccount ? (
                <div className="account-info">
                  <div className="account-name">{currentAccount.username}</div>
                  <div style={{ color: '#7A5A22' }}>
                    {currentAccount.type === 'microsoft' ? 'Microsoft Account' : 'Offline Account'}
                    {currentAccount.uuid && ` | UUID: ${currentAccount.uuid.substring(0, 8)}...`}
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2 }}>
                  <input
                    type="text"
                    placeholder="Quick offline username"
                    value={offlineName}
                    onChange={e => setOfflineName(e.target.value)}
                    style={{ flex: 1 }}
                    disabled={launching}
                  />
                  <button className="btn" onClick={handleOfflineSave} disabled={launching}>
                    Save
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="group-box" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="group-box-label">Version</div>
            <div className="form-row" style={{ marginBottom: 4, flexShrink: 0 }}>
              <input
                type="text"
                placeholder="Search versions..."
                value={versionSearch}
                onChange={e => {
                  const q = e.target.value;
                  setVersionSearch(q);
                  if (q.trim()) {
                    const matches = versions.filter(v =>
                      v.id.toLowerCase().includes(q.toLowerCase()) ||
                      formatVersion(v).toLowerCase().includes(q.toLowerCase())
                    );
                    if (matches.length > 0 && !matches.some(v => v.id === selectedVersion)) {
                      setSelectedVersion(matches[0].id);
                      saveSetting('lastVersion', matches[0].id);
                    }
                  }
                }}
                disabled={launching}
                style={{ flex: 1, marginRight: 4 }}
              />
              <button className="btn" onClick={refreshVersions} disabled={launching}>
                Refresh
              </button>
            </div>
            <div className="form-row" style={{ flexShrink: 0 }}>
              <select
                value={selectedVersion}
                onChange={e => {
                  const val = e.target.value;
                  setSelectedVersion(val);
                  saveSetting('lastVersion', val);
                }}
                disabled={launching}
                style={{ flex: 1 }}
              >
                {versions
                  .filter(v => {
                    if (!versionSearch.trim()) return true;
                    const q = versionSearch.toLowerCase();
                    return (
                      v.id.toLowerCase().includes(q) ||
                      formatVersion(v).toLowerCase().includes(q)
                    );
                  })
                  .map(v => (
                    <option key={v.id} value={v.id}>
                      {formatVersion(v)}
                    </option>
                  ))}
              </select>
            </div>
            <div className="log-toolbar">
              {hasError && (
                <button className="btn report-issue" onClick={() => window.velix.openExternal('https://github.com/Nexoruz-Labs/VelixLITE/issues')}>
                  Report Issue
                </button>
              )}
              <button className="btn" onClick={clearLog}>Clear</button>
            </div>
            <div className="launch-log" ref={logRef} onScroll={handleLogScroll}>
              {launchLog ? (
                launchLog.split('\n').map((line, i) => renderLogLine(line, i))
              ) : (
                <div>
                  <div className="log-info">Ready to launch</div>
                  <div className="log-info">⭐ Support VelixLITE by starring the repository!</div>
                  {renderLogLine('https://github.com/Nexoruz-Labs/VelixLITE', -1)}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="right-panel" style={showDonation ? { visibility: 'hidden' } : undefined}>
          <div className="group-box">
            <div className="group-box-label">Settings</div>
            <div className="settings-section">
              <div className="form-group">
                <label>Game Directory</label>
                <input type="text" value={settings.gameDirectory} onChange={e => saveSetting('gameDirectory', e.target.value)} disabled={launching} />
              </div>
              <div className="form-group">
                <label>Launch Profile</label>
                <select
                  value={settings.launchProfile}
                  onChange={e => saveSetting('launchProfile', e.target.value)}
                  disabled={launching}
                  style={{ flex: 1 }}
                >
                  {LAUNCH_PROFILES.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.icon} {p.label} — {p.desc}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>RAM</label>
                <select
                  value={RAM_PRESETS.includes(settings.ram) ? settings.ram : '__custom__'}
                  onChange={e => {
                    if (e.target.value === '__custom__') {
                      setCustomRamInput(settings.ram);
                      setShowCustomRam(true);
                    } else {
                      saveSetting('ram', parseInt(e.target.value));
                    }
                  }}
                  disabled={launching}
                >
                  {RAM_PRESETS.map(p => (
                    <option key={p} value={p}>{formatRamLabel(p)}</option>
                  ))}
                  <option value="__custom__">
                    {RAM_PRESETS.includes(settings.ram) ? 'Custom...' : `${settings.ram} MB (Custom)`}
                  </option>
                </select>
              </div>
              <button className="btn more-settings-btn" onClick={() => {
                setShowAdvancedSettings(true);
                window.velix.detectJava().then(setJavaInstalls);
              }}>
                More Settings...
              </button>
            </div>
          </div>
          <div className="group-box about-section">
            <div className="group-box-label">About</div>
<div className="about-name">VelixLITE</div>
            <div className="about-version">Version 1.0.0</div>
            <div className="about-disclaimer">Not affiliated with Mojang or Microsoft</div>
            <div className="about-divider"></div>
            <div className="about-footer">
              &copy; 2026 Nexoruz<br/>
              Powered by Potatoes.<br/>
              <a
                href="#"
                className="repo-link"
                onClick={e => {
                  e.preventDefault();
                  window.velix.openExternal('https://github.com/Nexoruz-Labs/VelixLITE');
                }}
              >
                github.com/Nexoruz-Labs/VelixLITE
              </a>
            </div>
            <div className="about-divider"></div>
            {donated ? (
              <div className="about-thanks">Thank you for your support! 🥔</div>
            ) : (
              <>
                <div className="about-donate-text">Love VelixLITE? Support development.</div>
                <button className="btn btn-primary about-donate-btn" onClick={openDonation}>
                  Donate via PayPal
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="bottom-section">
        <button className="play-button" onClick={handlePlay} disabled={launching || !selectedVersion}>
          {launching ? 'Launching...' : 'PLAY'}
        </button>
        <div className="progress-area">
          <div className="status-text">{status}</div>
          <div className="progress-bar-outer">
            <div className="progress-bar-inner" style={{ width: `${Math.min(progress, 100)}%` }} />
            <div className="progress-label">
              {launching ? `${progress}%` : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="status-bar">
        <div className="status-left">{status}</div>
        <div className="status-right">
          <span>v1.0.0</span>
        </div>
      </div>

      {showConfirmDialog && (
        <div className="confirm-overlay">
          <div className="confirm-dialog">
            <div className="confirm-dialog-title">Potato Confirmation</div>
            <div className="confirm-dialog-body">
              <span className="potato-icon">🥔</span>
              We want potatoes!<br/>
              Are you sure you don't want to support the development?
            </div>
            <div className="confirm-dialog-actions">
              <button className="btn btn-primary about-donate-btn" onClick={handleConfirmContinue}>
                Continue Donation
              </button>
              <button className="btn" onClick={handleConfirmDonated}>
                I Already Donated!
              </button>
              <button className="btn" onClick={handleConfirmReturn}>
                Return to Main
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdvancedSettings && (
        <div className="confirm-overlay">
          <div className="advanced-modal">
            <div className="confirm-dialog-title">Advanced Settings</div>
            <div className="advanced-modal-body">
              <div className="tab-bar">
                {(['display', 'launch', 'java'] as const).map(tab => (
                  <button key={tab} className={`tab-btn ${activeAdvTab === tab ? 'active' : ''}`} onClick={() => setActiveAdvTab(tab)}>
                    {tab === 'display' ? 'Display' : tab === 'launch' ? 'Launch' : 'Java'}
                  </button>
                ))}
              </div>
              <div className="tab-content">
                {activeAdvTab === 'display' && (
                  <div className="adv-settings-scroll">
                    <div className="form-group">
                      <label>Display Mode</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {(['windowed', 'fullscreen'] as const).map(mode => (
                          <label key={mode} className="radio-label">
                            <input type="radio" name="advDisplayMode" value={mode}
                              checked={settings.displayMode === mode}
                              onChange={() => saveSetting('displayMode', mode)}
                            />
                            <span>{mode === 'windowed' ? 'Windowed' : 'Fullscreen'}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    {settings.displayMode === 'fullscreen' && (
                      <>
                        <div className="form-group">
                          <label>Fullscreen Resolution</label>
                          <div className="form-row">
                            <input type="number" min={320} max={7680} value={settings.fullscreenResWidth}
                              onChange={e => saveSetting('fullscreenResWidth', parseInt(e.target.value) || 854)}
                              style={{ width: 70 }} />
                            <span style={{ color: '#7A5A22' }}>×</span>
                            <input type="number" min={240} max={4320} value={settings.fullscreenResHeight}
                              onChange={e => saveSetting('fullscreenResHeight', parseInt(e.target.value) || 480)}
                              style={{ width: 60 }} />
                          </div>
                          <select onChange={e => {
                            if (e.target.value) {
                              const [w, h] = e.target.value.split('×').map(Number);
                              saveSetting('fullscreenResWidth', w);
                              saveSetting('fullscreenResHeight', h);
                            }
                          }} style={{ width: '100%', marginTop: 3, fontSize: 10 }}
                            defaultValue="">
                            <option value="">Common presets</option>
                            <option value="1024×768">1024×768</option>
                            <option value="1280×720">1280×720</option>
                            <option value="1366×768">1366×768</option>
                            <option value="1600×900">1600×900</option>
                            <option value="1920×1080">1920×1080</option>
                            <option value="2560×1440">2560×1440</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label className="radio-label" style={{ position: 'relative' }}>
                            <input type="checkbox" checked={settings.forceDisplayResolution}
                              onChange={e => saveSetting('forceDisplayResolution', e.target.checked)}
                            />
                            <span>Force Display Resolution</span>
                          </label>
                          <div style={{ fontSize: 9, color: '#7A5A22', marginTop: 2, marginLeft: 18, lineHeight: 1.4 }}>
                            Temporarily changes your monitor resolution while Minecraft is running. Your original resolution will be restored automatically when the game closes.
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {activeAdvTab === 'launch' && (
                  <div className="adv-settings-scroll">
                    <div className="form-group">
                      <label className="radio-label">
                        <input type="checkbox" checked={settings.closeAfterLaunch}
                          onChange={e => saveSetting('closeAfterLaunch', e.target.checked)}
                        />
                        <span>Close launcher after launch</span>
                      </label>
                    </div>
                  </div>
                )}
                {activeAdvTab === 'java' && (
                  <div className="adv-settings-scroll">
                    <div className="form-group">
                      <label className="radio-label">
                        <input type="checkbox" checked={settings.autoInstallJava}
                          onChange={e => {
                            saveSetting('autoInstallJava', e.target.checked);
                            if (e.target.checked) window.velix.detectJava().then(setJavaInstalls);
                          }}
                        />
                        <span>Auto-install Java</span>
                      </label>
                      <div style={{ fontSize: 9, color: '#7A5A22', marginTop: 1, marginLeft: 18, lineHeight: 1.4 }}>
                        Automatically downloads the required Java version for each Minecraft version.
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Java Path</label>
                      <input type="text" value={settings.javaPath} onChange={e => saveSetting('javaPath', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label>JVM Arguments</label>
                      <textarea value={settings.jvmArgs} onChange={e => saveSetting('jvmArgs', e.target.value)}
                        rows={4} style={{ width: '100%', resize: 'vertical', fontFamily: 'Consolas, monospace', fontSize: 10, padding: 3, border: '1px solid #D3AE5D', borderRadius: 3, background: '#FFFDF7', color: '#3C2A0E' }} />
                    </div>
                    {javaInstalls.length > 0 && (
                      <div className="form-group">
                        <label>Detected Java Installations</label>
                        <div style={{ fontSize: 9, maxHeight: 100, overflowY: 'auto', border: '1px solid #E4CB8E', borderRadius: 3, padding: 3, background: '#FFFDF7' }}>
                          {javaInstalls.map((j, i) => (
                            <div key={i} style={{ padding: '2px 0', borderBottom: i < javaInstalls.length - 1 ? '1px solid #F0E4C6' : 'none' }}>
                              <span style={{ color: '#3D8B37', fontSize: 10, marginRight: 2 }}>✓</span>
                              <strong>{j.displayName}</strong>
                              <div style={{ color: '#7A5A22', marginLeft: 14, wordBreak: 'break-all' }}>{j.path}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ marginTop: 4 }}>
                      <button className="btn" onClick={() => window.velix.detectJava().then(setJavaInstalls)} style={{ fontSize: 9 }}>
                        Refresh Java Detection
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="advanced-modal-footer">
              <button className="btn" onClick={() => {
                window.velix.getSettings().then((s: Settings) => { if (s) setSettings(s); });
                setShowAdvancedSettings(false);
              }}>Cancel</button>
              <button className="btn btn-primary" onClick={() => setShowAdvancedSettings(false)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {showCustomRam && (
        <div className="confirm-overlay">
          <div className="confirm-dialog" style={{ maxWidth: 320 }}>
            <div className="confirm-dialog-title">Custom RAM Allocation</div>
            <div className="confirm-dialog-body" style={{ textAlign: 'left' }}>
              <div className="form-group">
                <label>RAM (MB)</label>
                <input type="number" value={customRamInput} onChange={e => setCustomRamInput(parseInt(e.target.value) || 512)} autoFocus style={{ width: '100%' }} />
              </div>
              <div style={{ fontSize: 9, color: '#7A5A22', marginTop: 4 }}>
                <div>Installed RAM: {Math.floor(systemRam / 1024 / 1024 / 1024 * 10) / 10} GB</div>
                <div>Recommended: {Math.min(6144, Math.floor(systemRam / 1024 / 1024))} MB</div>
              </div>
              {customRamInput > systemRam / 1024 / 1024 * 0.75 && (
                <div style={{ fontSize: 9, color: '#A02E24', marginTop: 4 }}>High allocation — may affect performance.</div>
              )}
            </div>
            <div className="confirm-dialog-actions" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', gap: 4 }}>
              <button className="btn" onClick={() => setShowCustomRam(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => {
                let v = Math.max(512, Math.min(customRamInput, Math.floor(systemRam / 1024 / 1024)));
                saveSetting('ram', v);
                setShowCustomRam(false);
              }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
