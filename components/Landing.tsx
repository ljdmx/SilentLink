
import React from 'react';

interface LandingProps {
  onNavigateToSetup: () => void;
  onViewDesign: () => void;
}

const Landing: React.FC<LandingProps> = ({ onNavigateToSetup, onViewDesign }) => {
  return (
    <div className="flex min-h-screen w-full bg-background selection:bg-primary/30">
      {/* Side Decorative Pane */}
      <div className="hidden lg:flex w-[45%] relative flex-col justify-between p-16 overflow-hidden border-r border-white/5">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-transparent to-transparent opacity-40"></div>
        <div className="absolute top-[-10%] right-[-10%] size-96 bg-primary/10 blur-[120px] rounded-full"></div>
        
        <div className="relative z-10 flex items-center gap-3">
            <div className="size-10 bg-primary flex items-center justify-center rounded-xl shadow-2xl shadow-primary/40">
                <span className="material-symbols-outlined text-white text-xl fill-1">shield</span>
            </div>
            <span className="font-black text-xl tracking-tight">SECURE<span className="text-primary">COMM</span></span>
        </div>

        <div className="relative z-10 space-y-8">
            <h1 className="text-7xl font-black leading-[1.05] tracking-tighter">
                私密通讯的<br/>
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-blue-400">数字避难所</span>
            </h1>
            <p className="text-lg text-gray-500 max-w-md font-medium leading-relaxed">
                无需注册，无需安装。基于 WebRTC 与 AES-256-GCM 硬件级加密，确保您的对话仅留存在参与者的内存中。
            </p>
            <div className="grid grid-cols-2 gap-8 pt-8">
                <Feature icon="memory" title="内存级运行" desc="关闭即焚，无本地/云端持久化存储。" />
                <Feature icon="stream" title="帧级加密" desc="Insertable Streams 确保中转节点不可见。" />
                <Feature icon="encrypted" title="P2P 架构" desc="真正意义上的点对点，绕过中心监管。" />
                <Feature icon="security" title="防截屏防护" desc="智能检测窗口状态，实时画面自动脱敏。" />
            </div>
        </div>

        <div className="relative z-10 text-[10px] font-mono text-gray-600 uppercase tracking-widest flex items-center gap-4">
            <span>Protocol v1.2.0</span>
            <span className="size-1 rounded-full bg-gray-800"></span>
            <span>E2EE Certified</span>
        </div>
      </div>

      {/* Main Action Pane */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 lg:p-24 bg-[#080a0c]">
        <div className="w-full max-w-sm space-y-12">
            <div className="lg:hidden flex justify-center mb-8">
                <div className="size-16 bg-primary/10 border border-primary/20 flex items-center justify-center rounded-2xl">
                    <span className="material-symbols-outlined text-primary text-3xl fill-1">shield</span>
                </div>
            </div>

            <div className="text-center space-y-4">
                <h2 className="text-3xl lg:text-4xl font-black tracking-tight text-white">建立受保护节点</h2>
                <p className="text-gray-500 font-medium text-sm">选择一个加密身份并开始通讯</p>
            </div>

            <div className="space-y-4">
                <button 
                  onClick={onNavigateToSetup} 
                  className="w-full h-16 bg-primary hover:bg-blue-600 text-white rounded-2xl font-bold transition-all shadow-2xl shadow-primary/30 flex items-center justify-center gap-3 group active:scale-95"
                >
                    <span>初始化安全频道</span>
                    <span className="material-symbols-outlined text-xl transition-transform group-hover:translate-x-1">north_east</span>
                </button>
                <button 
                  onClick={onViewDesign}
                  className="w-full h-16 bg-white/5 border border-white/5 hover:bg-white/10 text-white rounded-2xl font-bold transition-all flex items-center justify-center gap-3 active:scale-95 group"
                >
                    <span className="material-symbols-outlined text-gray-400 group-hover:text-primary transition-colors">architecture</span>
                    <span>技术原理白皮书</span>
                </button>
            </div>

            <div className="pt-8 border-t border-white/5 flex flex-col items-center gap-4">
                <div className="flex -space-x-3">
                    {[1,2,3].map(i => (
                        <div key={i} className="size-8 rounded-full border-2 border-background bg-surface overflow-hidden">
                            <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${i+10}`} alt="avatar" />
                        </div>
                    ))}
                    <div className="size-8 rounded-full border-2 border-background bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold">
                        +5k
                    </div>
                </div>
                <p className="text-[10px] text-gray-600 font-bold uppercase tracking-[0.2em]">已保护超过 50,000+ 次通话</p>
            </div>
        </div>
      </div>
    </div>
  );
};

const Feature = ({ icon, title, desc }: { icon: string; title: string; desc: string }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2 text-primary">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
        <h4 className="font-bold text-xs uppercase tracking-widest">{title}</h4>
    </div>
    <p className="text-[11px] text-gray-600 leading-relaxed">{desc}</p>
  </div>
);

export default Landing;
