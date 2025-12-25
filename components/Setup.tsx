
import React, { useState } from 'react';
import { RoomConfig, PrivacyFilter, ViewMode } from '../types';

interface SetupProps {
  onBack: () => void;
  onStart: (config: RoomConfig) => void;
  onViewDesign?: () => void;
}

const Setup: React.FC<SetupProps> = ({ onBack, onStart, onViewDesign }) => {
  const [userName, setUserName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [defaultFilter, setDefaultFilter] = useState<PrivacyFilter>(PrivacyFilter.MOSAIC);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userName || !passphrase) return;
    onStart({
      roomId: roomName.trim().toUpperCase() || Math.random().toString(36).substring(7).toUpperCase(),
      passphrase,
      userName,
      recordingProtection: true,
      ephemeralSession: true,
      defaultFilter,
    });
  };

  return (
    <div className="min-h-screen bg-[#0a0f14] flex flex-col items-center justify-center p-4 lg:p-6 overflow-y-auto selection:bg-primary/30">
      <div className="w-full max-w-2xl bg-surface/30 border border-white/5 rounded-[2rem] lg:rounded-[3rem] p-6 lg:p-12 shadow-2xl backdrop-blur-3xl my-8 relative overflow-hidden">
        {/* 背景光效 */}
        <div className="absolute top-0 right-0 size-64 bg-primary/5 blur-[80px] -mr-32 -mt-32"></div>

        <button onClick={onBack} className="flex items-center gap-2 text-gray-500 hover:text-white mb-8 transition-colors group text-sm relative z-10">
          <span className="material-symbols-outlined group-hover:-translate-x-1 transition-transform">arrow_back</span>
          <span className="font-bold uppercase tracking-widest">返回主页</span>
        </button>

        <h1 className="text-2xl lg:text-4xl font-black mb-2 tracking-tight text-white relative z-10">配置安全节点</h1>
        <p className="text-gray-500 mb-8 lg:mb-12 font-medium text-sm lg:text-base relative z-10">进入房间前，请确保您与对端使用相同的<span className="text-primary">房间 ID</span>和<span className="text-primary">会话口令</span>。</p>

        <form onSubmit={handleSubmit} className="space-y-6 lg:space-y-8 relative z-10">
          <div className="space-y-6">
            {/* 房间 ID 输入 - 新增 */}
            <div className="space-y-3">
              <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-primary"></span>
                房间 ID
              </label>
              <input 
                autoComplete="off"
                className="w-full h-14 bg-black/40 border border-white/5 rounded-2xl px-5 focus:ring-2 focus:ring-primary outline-none transition-all placeholder:text-gray-700 text-white font-mono uppercase tracking-widest"
                placeholder="留空则自动生成新房间"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
              <div className="space-y-3">
                <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-gray-600"></span>
                  个人显示名称
                </label>
                <input 
                  required
                  autoComplete="off"
                  className="w-full h-14 bg-black/40 border border-white/5 rounded-2xl px-5 focus:ring-2 focus:ring-primary outline-none transition-all placeholder:text-gray-700 text-white"
                  placeholder="例如：匿名用户"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                />
              </div>
              <div className="space-y-3">
                <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-accent"></span>
                  会话加密口令
                </label>
                <input 
                  required
                  type="password"
                  className="w-full h-14 bg-black/40 border border-white/5 rounded-2xl px-5 focus:ring-2 focus:ring-primary outline-none transition-all placeholder:text-gray-700 text-white"
                  placeholder="双方口令必须完全一致"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-5">
            <h3 className="text-sm lg:text-lg font-black flex items-center gap-2 text-gray-300">
              <span className="material-symbols-outlined text-primary fill-1">shield</span> 
              默认隐私策略
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-black/40 rounded-2xl p-4 border border-white/5 border-l-4 border-l-primary flex items-center justify-between">
                <div className="flex gap-4 items-center">
                  <span className="material-symbols-outlined text-primary">blur_circular</span>
                  <div>
                    <h4 className="font-bold text-xs lg:text-sm">初始视频脱敏</h4>
                    <p className="text-[9px] lg:text-[10px] text-gray-500 mt-1 uppercase tracking-tighter">保护第一视角</p>
                  </div>
                </div>
                <select 
                  className="bg-[#121820] border border-white/10 rounded-xl text-[10px] px-3 py-2 outline-none font-bold text-primary"
                  value={defaultFilter}
                  onChange={(e) => setDefaultFilter(e.target.value as PrivacyFilter)}
                >
                  <option value={PrivacyFilter.NONE}>公开 </option>
                  <option value={PrivacyFilter.BLUR}>模糊</option>
                  <option value={PrivacyFilter.MOSAIC}>马赛克 </option>
                  <option value={PrivacyFilter.BLACK}>隐藏</option>
                </select>
              </div>
              <div className="bg-black/20 rounded-2xl p-4 border border-white/5 flex gap-4 items-center opacity-50 select-none">
                <span className="material-symbols-outlined text-gray-500">lock_reset</span>
                <div>
                   <h4 className="font-bold text-xs lg:text-sm">自动旋转密钥</h4>
                   <p className="text-[10px] text-gray-500 mt-1 uppercase">端到端硬件级加固</p>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-6">
            <button 
                type="submit" 
                disabled={!userName || !passphrase}
                className="w-full h-16 bg-primary rounded-2xl font-black text-base lg:text-lg shadow-xl shadow-primary/20 hover:scale-[1.01] active:scale-95 transition-all disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed text-white uppercase tracking-widest"
            >
              {roomName ? '加入加密频道' : '初始化新频道'}
            </button>
            
            <div className="flex flex-col items-center gap-6 mt-8">
              <p className="text-[9px] text-gray-600 uppercase tracking-[0.2em] font-black">
                Zero Metadata Persistence • Peer-to-Peer Verified
              </p>
              
              {onViewDesign && (
                <button 
                  type="button"
                  onClick={onViewDesign}
                  className="flex items-center gap-2 text-primary/60 hover:text-primary transition-all group"
                >
                  <span className="material-symbols-outlined text-sm">architecture</span>
                  <span className="text-[10px] font-mono font-bold uppercase tracking-widest border-b border-primary/20 group-hover:border-primary transition-all">
                    技术原理：如何实现零存储 E2EE？
                  </span>
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Setup;
