
import React, { useState, useEffect, useCallback } from 'react';
import Landing from './components/Landing';
import Setup from './components/Setup';
import Room from './components/Room';
import SystemDesign from './components/SystemDesign';
import { ViewMode, RoomConfig, PrivacyFilter } from './types';

const App: React.FC = () => {
  const [view, setView] = useState<ViewMode>(ViewMode.LANDING);
  const [roomConfig, setRoomConfig] = useState<RoomConfig | null>(null);
  const [isTabFocused, setIsTabFocused] = useState(true);

  const checkMagicLink = useCallback(() => {
    const hash = window.location.hash;
    if (hash.includes('offer=')) {
      const params = new URLSearchParams(hash.substring(1));
      const roomId = params.get('room') || 'SECURE_P2P';
      const passphrase = params.get('pass') || 'SECURE_KEY';
      const offer = params.get('offer') || '';
      
      const config: RoomConfig = {
        roomId,
        passphrase,
        userName: `访客_${Math.random().toString(36).substring(7)}`,
        recordingProtection: true,
        ephemeralSession: true,
        defaultFilter: PrivacyFilter.NONE,
        initialOffer: offer,
      };
      
      setRoomConfig(config);
      setView(ViewMode.ROOM);
    }
  }, []);

  useEffect(() => {
    checkMagicLink();
    window.addEventListener('hashchange', checkMagicLink);
    return () => window.removeEventListener('hashchange', checkMagicLink);
  }, [checkMagicLink]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabFocused(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const handleStartSession = useCallback((config: RoomConfig) => {
    setRoomConfig(config);
    setView(ViewMode.ROOM);
  }, []);

  const handleExit = useCallback(() => {
    setRoomConfig(null);
    setView(ViewMode.LANDING);
    window.location.hash = '';
  }, []);

  return (
    <div className={`min-h-screen transition-all duration-700 ${!isTabFocused && view === ViewMode.ROOM ? 'blur-3xl grayscale' : ''}`}>
      {view === ViewMode.LANDING && (
        <Landing 
            onNavigateToSetup={() => setView(ViewMode.SETUP)} 
            onViewDesign={() => setView(ViewMode.DESIGN)}
        />
      )}
      
      {view === ViewMode.SETUP && (
        <Setup 
          onBack={() => setView(ViewMode.LANDING)} 
          onStart={handleStartSession} 
          onViewDesign={() => setView(ViewMode.DESIGN)}
        />
      )}

      {view === ViewMode.ROOM && roomConfig && (
        <Room 
          config={roomConfig} 
          onExit={handleExit} 
        />
      )}

      {view === ViewMode.DESIGN && (
          <SystemDesign onBack={() => (roomConfig ? setView(ViewMode.ROOM) : setView(ViewMode.LANDING))} />
      )}

      {!isTabFocused && view === ViewMode.ROOM && (
        <div className="fixed inset-0 z-[9999] bg-background/90 flex items-center justify-center backdrop-blur-3xl animate-in fade-in duration-500">
          <div className="text-center">
            <div className="size-24 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-6 border border-primary/30 shadow-[0_0_50px_rgba(19,127,236,0.3)]">
                <span className="material-symbols-outlined text-primary text-5xl animate-pulse">shield_lock</span>
            </div>
            <h2 className="text-3xl font-black mb-2 tracking-tight text-white">隐私屏蔽已激活</h2>
            <p className="text-gray-400 font-medium text-sm">检测到窗口失焦，实时画面已自动切断。</p>
            <div className="mt-8 px-6 py-2 bg-primary/10 border border-primary/20 rounded-full inline-flex items-center gap-2">
                <span className="size-2 rounded-full bg-primary animate-ping"></span>
                <span className="text-xs font-bold text-primary uppercase tracking-widest">Secure Protocol Running</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
