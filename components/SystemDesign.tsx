
import React from 'react';

interface SystemDesignProps {
  onBack: () => void;
}

const SystemDesign: React.FC<SystemDesignProps> = ({ onBack }) => {
  return (
    <div className="min-h-screen bg-background p-5 md:p-10 lg:p-20 overflow-y-auto selection:bg-primary/30 custom-scrollbar relative">
      {/* 装饰性背景元素 */}
      <div className="fixed top-0 left-0 w-full h-full pointer-events-none opacity-[0.04] z-0 overflow-hidden">
        <div className="absolute top-[-10%] left-[-5%] w-[80%] lg:w-[40%] aspect-square bg-primary blur-[100px] lg:blur-[150px] rounded-full"></div>
        <div className="absolute bottom-[-5%] right-[-5%] w-[70%] lg:w-[30%] aspect-square bg-accent blur-[80px] lg:blur-[120px] rounded-full"></div>
      </div>

      <div className="max-w-7xl mx-auto space-y-16 lg:space-y-32 relative z-10">
        {/* 顶部导航与标题 */}
        <div className="space-y-8 lg:space-y-12 animate-in slide-in-from-top duration-700">
            <button 
              onClick={onBack} 
              className="flex items-center gap-2 text-primary/90 font-bold hover:text-primary transition-all group px-4 py-2.5 rounded-xl border border-primary/20 bg-primary/5 active:scale-95"
            >
                <span className="material-symbols-outlined text-[18px] group-hover:-translate-x-1 transition-transform">arrow_back</span>
                <span className="uppercase tracking-[0.2em] text-[10px] font-black">安全退出文档</span>
            </button>

            <div className="space-y-6">
                <div className="flex items-center gap-3">
                    <span className="h-px w-6 lg:w-12 bg-primary/40"></span>
                    <span className="text-primary font-mono text-[9px] lg:text-[11px] uppercase tracking-[0.4em] font-black">SecureComm 协议规格书 v1.2</span>
                </div>
                <h1 className="text-[3.2rem] md:text-6xl lg:text-8xl font-black tracking-tighter uppercase leading-[0.9] lg:leading-[0.85]">
                    <span className="text-white">零信任</span><br/>
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary via-blue-400 to-accent">加固架构</span>
                </h1>
                
                <div className="flex flex-wrap items-center gap-4 lg:gap-6 text-gray-500 font-mono text-[9px] lg:text-[10px] uppercase tracking-[0.2em] pt-2">
                    <div className="flex items-center gap-2">编号: <span className="text-gray-300">SC-A-25</span></div>
                    <span className="opacity-20">•</span>
                    <div className="flex items-center gap-2">级别: <span className="text-gray-300">E2EE</span></div>
                    <span className="opacity-20">•</span>
                    <div className="flex items-center gap-2">状态: <span className="text-accent font-bold">已自证</span></div>
                </div>
            </div>
        </div>

        {/* 蓝图核心区域 */}
        <section className="space-y-8">
            <div className="flex items-center gap-3">
                <span className="size-2 rounded-full bg-primary shadow-[0_0_10px_rgba(19,127,236,0.8)]"></span>
                <h2 className="text-[11px] lg:text-xs font-black uppercase tracking-[0.2em] text-gray-400">系统拓扑与全链路加密流向</h2>
            </div>

            <div className="relative group">
                <div className="absolute -inset-0.5 bg-gradient-to-br from-primary/30 via-white/5 to-accent/30 rounded-[2.5rem] opacity-30 blur-md group-hover:opacity-50 transition-opacity"></div>
                
                <div className="relative glass rounded-[2.5rem] lg:rounded-[3rem] p-8 md:p-12 lg:p-24 overflow-hidden min-h-[600px] flex flex-col justify-center border-white/10 shadow-3xl bg-[#06080a]/80">
                    <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
                    
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-16 lg:gap-8 items-center relative z-10">
                        {/* 节点 A: 发起端 */}
                        <div className="lg:col-span-4 flex flex-col items-center lg:items-end text-center lg:text-right space-y-8 group/node">
                            <div className="w-full max-w-[280px] lg:max-w-none aspect-square rounded-[2.5rem] bg-[#0a0f16] border border-primary/20 flex flex-col items-center justify-center relative p-8 group-hover/node:border-primary/50 transition-all duration-700 shadow-[inset_0_0_40px_rgba(19,127,236,0.05)]">
                                <div className="absolute -top-3 px-4 py-1.5 bg-primary text-[8px] lg:text-[9px] font-black rounded-full uppercase tracking-widest text-white shadow-xl">源发起节点</div>
                                <span className="material-symbols-outlined text-5xl lg:text-7xl text-primary mb-4 animate-float">terminal</span>
                                <div className="space-y-2">
                                    <p className="text-[10px] lg:text-[11px] font-black text-gray-200 uppercase tracking-widest">数据标准化处理</p>
                                    <div className="flex gap-1.5 justify-center lg:justify-end opacity-40">
                                        {[1,2,3,4].map(i => <div key={i} className="size-1.5 bg-primary rounded-full"></div>)}
                                    </div>
                                </div>
                                <div className="absolute bottom-4 font-mono text-[8px] text-primary/30">ID: 0x7FF1</div>
                            </div>
                            <div className="space-y-3 px-2">
                                <h4 className="text-sm lg:text-lg font-black uppercase tracking-widest text-white">本地采集与脱敏层</h4>
                                <p className="text-[11px] lg:text-[12px] text-gray-500 leading-relaxed font-medium">数据离开浏览器前，隐私滤镜在 WebGL 层面执行，确保原始像素永不暴露于内存区之外。</p>
                            </div>
                        </div>

                        {/* 连接桥接区: 隧道 */}
                        <div className="lg:col-span-4 flex flex-row lg:flex-col items-center justify-center gap-6 lg:gap-14 py-4 lg:py-0">
                            {/* 移动端垂直指示器 */}
                            <div className="lg:hidden h-20 w-px bg-gradient-to-b from-primary via-white/20 to-accent flex flex-col items-center justify-around">
                                <div className="size-2 bg-primary rounded-full shadow-[0_0_8px_#137fec]"></div>
                                <div className="size-2 bg-accent rounded-full shadow-[0_0_8px_#22c55e]"></div>
                            </div>

                            <div className="relative">
                                <div className="absolute -inset-10 bg-primary/10 blur-[50px] rounded-full opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                <div className="p-8 lg:p-12 glass rounded-[2.5rem] lg:rounded-[3rem] border-white/10 text-center space-y-5 lg:space-y-6 relative max-w-[180px] lg:max-w-[280px] bg-black/60 shadow-2xl">
                                    <div className="size-14 lg:size-20 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto shadow-inner group-hover:border-primary/30 transition-colors">
                                        <span className="material-symbols-outlined text-gray-400 text-3xl lg:text-4xl group-hover:text-primary transition-colors">hub</span>
                                    </div>
                                    <div className="space-y-2">
                                        <h5 className="text-[10px] lg:text-[11px] font-black uppercase tracking-[0.3em] text-white">WebRTC 隧道</h5>
                                        <p className="text-[9px] lg:text-[10px] text-gray-500 leading-relaxed uppercase font-black">ICE / STUN / TURN<br/><span className="text-primary/60">端到端中继完成</span></p>
                                    </div>
                                </div>
                            </div>

                            {/* 桌面端横向连接线 */}
                            <div className="hidden lg:block w-full relative h-px bg-gradient-to-r from-primary/40 via-white/10 to-accent/40">
                                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-2 bg-white rounded-full blur-[2px]"></div>
                            </div>
                        </div>

                        {/* 节点 B: 接收端 */}
                        <div className="lg:col-span-4 flex flex-col items-center lg:items-start text-center lg:text-left space-y-8 group/node2">
                            <div className="w-full max-w-[280px] lg:max-w-none aspect-square rounded-[2.5rem] bg-[#0a110d] border border-accent/20 flex flex-col items-center justify-center relative p-8 group-hover/node2:border-accent/50 transition-all duration-700 shadow-[inset_0_0_40px_rgba(34,197,94,0.05)]">
                                <div className="absolute -top-3 px-4 py-1.5 bg-accent text-[8px] lg:text-[9px] font-black rounded-full uppercase tracking-widest text-black shadow-xl">目标接收节点</div>
                                <span className="material-symbols-outlined text-5xl lg:text-7xl text-accent mb-4 animate-float" style={{animationDelay: '1.5s'}}>security</span>
                                <div className="space-y-2">
                                    <p className="text-[10px] lg:text-[11px] font-black text-gray-200 uppercase tracking-widest">实时流式合成</p>
                                    <div className="flex gap-1.5 justify-center lg:justify-start opacity-40">
                                        {[1,2,3,4].map(i => <div key={i} className="size-1.5 bg-accent rounded-full"></div>)}
                                    </div>
                                </div>
                                <div className="absolute bottom-4 font-mono text-[8px] text-accent/30">STATUS: E2EE-OK</div>
                            </div>
                            <div className="space-y-3 px-2">
                                <h4 className="text-sm lg:text-lg font-black uppercase tracking-widest text-white">硬件解密渲染层</h4>
                                <p className="text-[11px] lg:text-[12px] text-gray-500 leading-relaxed font-medium">接收端利用 AES-NI 指令集执行实时分片解密。视频帧处理后即刻物理销毁状态，不可追溯。</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        {/* 技术细项网格 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-10">
            <TechnicalCard 
                label="技术层 01" 
                title="密钥生命周期" 
                icon="key" 
                desc="采用双向不重叠派生策略。会话密钥存储于受硬件保护的内存隔离区，网页关闭即物理销毁。" 
            />
            <TechnicalCard 
                label="技术层 02" 
                title="分片传输协议" 
                icon="splitscreen" 
                desc="大文件拆分为 16KB 加密指令包。结合 WebRTC SCTP 特性，实现零延迟感知的端到端流加解密。" 
            />
            <TechnicalCard 
                label="技术层 03" 
                title="自适应脱敏" 
                icon="filter_center_focus" 
                desc="通过 Canvas API 在 WebGL 层面拦截。在媒体流流入信道前完成物理级的视觉屏蔽。" 
            />
            <TechnicalCard 
                label="技术层 04" 
                title="安全审计" 
                icon="verified" 
                desc="支持一次性会话指纹验证。双方通过验证指纹确保 MITM 攻击不可能发生。" 
            />
            <TechnicalCard 
                label="技术层 05" 
                title="零痕迹架构" 
                icon="cloud_off" 
                desc="强制剔除所有持久化存储。所有逻辑完全在堆内存运行，保证无任何磁盘取证痕迹。" 
            />
            <TechnicalCard 
                label="技术层 06" 
                title="环境感知探针" 
                icon="error" 
                desc="内置探测器。当检测到开发者工具或失焦时，系统自动启动熔断机制，切断敏感流。" 
            />
        </div>

        {/* 底部技术规格 */}
        <div className="pt-16 lg:pt-24 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-10 lg:gap-12 opacity-60 pb-16">
            <div className="flex flex-wrap justify-center md:justify-start items-center gap-8 lg:gap-10">
                <div className="flex flex-col gap-1.5">
                    <span className="text-[9px] lg:text-[11px] font-black uppercase tracking-widest text-white">加密算法</span>
                    <span className="text-[8px] lg:text-[10px] font-mono text-gray-400">AES-256-GCM / PBKDF2 (100k iter)</span>
                </div>
                <div className="h-8 w-px bg-white/10 hidden md:block"></div>
                <div className="flex flex-col gap-1.5">
                    <span className="text-[9px] lg:text-[11px] font-black uppercase tracking-widest text-white">传输协议</span>
                    <span className="text-[8px] lg:text-[10px] font-mono text-gray-400">WebRTC SCTP / DTLS 1.2 / SRTP</span>
                </div>
            </div>
            
            <p className="text-[8px] lg:text-[10px] font-mono text-center md:text-right max-w-sm leading-relaxed">
                本系统受 SecureComm 去中心化标准保护。在当前全球算力背景下，通过数学手段进行非法拦截是不可行的。
            </p>
        </div>
      </div>
    </div>
  );
};

const TechnicalCard = ({ label, title, desc, icon }: { label: string; title: string; desc: string; icon: string }) => (
    <div className="group p-8 lg:p-12 bg-[#0d1117]/60 border border-white/5 rounded-[2.5rem] space-y-8 hover:bg-[#121820]/80 transition-all duration-700 relative overflow-hidden hover:border-primary/20 shadow-2xl hover:shadow-primary/5">
        <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover:opacity-[0.08] transition-opacity pointer-events-none">
            <span className="material-symbols-outlined text-[100px] lg:text-[140px] -mr-8 -mt-8">{icon}</span>
        </div>
        
        <div className="flex items-center justify-between relative z-10">
            <span className="text-primary font-mono text-[9px] lg:text-[10px] font-black tracking-[0.4em] uppercase">{label}</span>
            <div className="size-11 lg:size-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-gray-400 group-hover:text-primary group-hover:bg-primary/10 group-hover:border-primary/30 transition-all duration-500">
                <span className="material-symbols-outlined text-xl lg:text-2xl">{icon}</span>
            </div>
        </div>

        <div className="space-y-4 relative z-10">
            <h4 className="text-lg lg:text-xl font-black uppercase tracking-tight text-white group-hover:translate-x-1 transition-transform">{title}</h4>
            <p className="text-[12px] lg:text-[13px] text-gray-400 leading-relaxed font-medium group-hover:text-gray-300 transition-colors">{desc}</p>
        </div>
        
        <div className="pt-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-700">
            {[1,2,3].map(i => <div key={i} className="h-0.5 w-4 lg:w-6 bg-primary/30 rounded-full"></div>)}
        </div>
    </div>
);

export default SystemDesign;
