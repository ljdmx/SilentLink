
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RoomConfig, Participant, PrivacyFilter, ChatMessage, FileTransfer, MessageType } from '../types';
import { deriveKey, encryptMessage, decryptMessage, encryptBuffer, decryptBuffer } from '../crypto';
import VideoCard from './VideoCard';

interface RoomProps {
  config: RoomConfig;
  onExit: () => void;
}

type HandshakeRole = 'none' | 'initiator' | 'receiver';

const Room: React.FC<RoomProps> = ({ config, onExit }) => {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<FileTransfer[]>([]);
  const [currentFilter, setCurrentFilter] = useState<PrivacyFilter>(config.defaultFilter);
  const [isMuted, setIsMuted] = useState(false);
  const [isRemoteMuted, setIsRemoteMuted] = useState(false);
  const [isRemoteHidden, setIsRemoteHidden] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  
  const [role, setRole] = useState<HandshakeRole>('none');
  const [localSDP, setLocalSDP] = useState('');
  const [remoteSDPInput, setRemoteSDPInput] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'preparing' | 'ready' | 'connected'>('idle');
  const [handshakeStep, setHandshakeStep] = useState(1);
  const [countdown, setCountdown] = useState(180);

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const encryptionKeyRef = useRef<CryptoKey | null>(null);
  
  const rawStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const filterCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const filterRef = useRef<PrivacyFilter>(config.defaultFilter);

  useEffect(() => {
    filterRef.current = currentFilter;
  }, [currentFilter]);

  const addParticipant = useCallback((p: Participant) => {
    setParticipants(prev => {
      const exists = prev.find(u => u.id === p.id);
      if (exists) return prev.map(u => u.id === p.id ? { ...u, ...p } : u);
      return [...prev, p];
    });
  }, []);

  const removeParticipant = useCallback((id: string) => {
    setParticipants(prev => prev.filter(u => u.id !== id));
    const pc = peersRef.current.get(id);
    if (pc) { pc.close(); peersRef.current.delete(id); }
    dataChannelsRef.current.delete(id);
  }, []);

  // 视频滤镜处理引擎
  useEffect(() => {
    let animationFrame: number;
    const canvas = filterCanvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;

    const render = () => {
      if (ctx && video.readyState >= 2) {
        const filter = filterRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        if (filter === PrivacyFilter.BLACK) {
          ctx.fillStyle = '#06080a';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else if (filter === PrivacyFilter.MOSAIC) {
          const scale = 0.05;
          const w = canvas.width * scale;
          const h = canvas.height * scale;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(video, 0, 0, w, h);
          ctx.drawImage(canvas, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
        } else if (filter === PrivacyFilter.BLUR) {
          ctx.filter = 'blur(40px)';
          ctx.drawImage(video, 0, 0);
          ctx.filter = 'none';
        } else {
          ctx.drawImage(video, 0, 0);
        }
      }
      animationFrame = requestAnimationFrame(render);
    };

    const interval = setInterval(() => {
        if (rawStreamRef.current && video.srcObject !== rawStreamRef.current) {
            video.srcObject = rawStreamRef.current;
            video.play().then(() => render()).catch(e => console.error("Filter engine failed", e));
        }
    }, 1000);

    return () => {
      cancelAnimationFrame(animationFrame);
      clearInterval(interval);
      video.pause();
      video.srcObject = null;
    };
  }, []);

  useEffect(() => {
    const init = async () => {
      encryptionKeyRef.current = await deriveKey(config.passphrase, config.roomId);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, 
          audio: true 
        });
        rawStreamRef.current = stream;
        const canvasStream = (filterCanvasRef.current as any).captureStream(30);
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) canvasStream.addTrack(audioTrack);
        processedStreamRef.current = canvasStream;
        addParticipant({ id: 'local', name: config.userName, isLocal: true, isHost: true, audioEnabled: true, videoEnabled: true, stream: canvasStream });
      } catch (err) { console.error("Media init error:", err); }
    };
    init();
    return () => {
      peersRef.current.forEach(pc => pc.close());
      rawStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [config.roomId, config.userName, config.passphrase, addParticipant]);

  const setupPeerConnection = async (remoteId: string, isOffer: boolean): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peersRef.current.set(remoteId, pc);
    processedStreamRef.current?.getTracks().forEach(track => { 
      if (processedStreamRef.current) pc.addTrack(track, processedStreamRef.current); 
    });
    pc.ontrack = (e) => { 
      addParticipant({ id: remoteId, name: "远端对等节点", isLocal: false, isHost: false, audioEnabled: true, videoEnabled: true, stream: e.streams[0] }); 
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setConnectionStatus('connected');
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) removeParticipant(remoteId);
    };
    if (isOffer) {
      const dc = pc.createDataChannel('secure-chat-tunnel', { ordered: true });
      setupDataChannel(remoteId, dc);
    } else { pc.ondatachannel = (e) => setupDataChannel(remoteId, e.channel); }
    return pc;
  };

  const setupDataChannel = (remoteId: string, dc: RTCDataChannel) => {
    dataChannelsRef.current.set(remoteId, dc);
    dc.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'chat' && encryptionKeyRef.current) {
            const text = await decryptMessage(encryptionKeyRef.current, payload.data, payload.iv);
            setMessages(prev => [...prev, { id: Date.now().toString(), senderId: remoteId, senderName: '对方', text, type: 'text', timestamp: Date.now() }]);
          } else if (payload.type === 'file-meta') handleFileMetaReceive(payload);
        } catch (err) { console.error("Payload parse failed:", err); }
      } else handleFileChunkReceive(e.data);
    };
  };

  const startAsInitiator = async () => {
    setRole('initiator'); 
    setConnectionStatus('preparing');
    const pc = await setupPeerConnection('peer', true);
    const offer = await pc.createOffer(); 
    await pc.setLocalDescription(offer);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        setLocalSDP(btoa(JSON.stringify(pc.localDescription))); setConnectionStatus('ready'); setHandshakeStep(2);
      }
    };
  };

  const finalizeAsInitiator = async () => {
    if (!remoteSDPInput) return;
    try {
      const decoded = JSON.parse(atob(remoteSDPInput));
      const pc = peersRef.current.get('peer');
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(decoded));
    } catch (e) { alert("握手响应无效"); }
  };

  const handleOfferAndReply = async () => {
    if (!remoteSDPInput) return;
    try {
      const decoded = JSON.parse(atob(remoteSDPInput));
      setConnectionStatus('preparing');
      const pc = await setupPeerConnection('peer', false);
      await pc.setRemoteDescription(new RTCSessionDescription(decoded));
      const answer = await pc.createAnswer(); 
      await pc.setLocalDescription(answer);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          setLocalSDP(btoa(JSON.stringify(pc.localDescription))); setConnectionStatus('ready'); setHandshakeStep(2);
        }
      };
    } catch (e) { alert("握手包解析失败"); }
  };

  const getInviteLink = () => {
    const url = new URL(window.location.href.split('#')[0]);
    url.hash = `room=${config.roomId}&pass=${config.passphrase}&offer=${localSDP}`;
    return url.toString();
  };

  const sendMessage = async (text: string) => {
    if (!encryptionKeyRef.current) return;
    try {
      const encrypted = await encryptMessage(encryptionKeyRef.current, text);
      const payload = JSON.stringify({ type: 'chat', ...encrypted });
      let hasSent = false;
      dataChannelsRef.current.forEach(dc => { if (dc.readyState === 'open') { dc.send(payload); hasSent = true; } });
      if (hasSent) setMessages(prev => [...prev, { id: Date.now().toString(), senderId: 'local', senderName: config.userName, text, type: 'text', timestamp: Date.now() }]);
    } catch (e) { console.error("Send failed", e); }
  };

  const handleFileUpload = async (file: File) => {
    if (!encryptionKeyRef.current) return;
    const fileId = Math.random().toString(36).substring(7);
    setFiles(prev => [{ id: fileId, name: file.name, size: file.size, progress: 0, status: 'transferring', mimeType: file.type }, ...prev]);
    const meta = JSON.stringify({ type: 'file-meta', id: fileId, name: file.name, size: file.size, mimeType: file.type });
    dataChannelsRef.current.forEach(dc => { if (dc.readyState === 'open') dc.send(meta); });
    const reader = file.stream().getReader();
    let offset = 0;
    const chunks: ArrayBuffer[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.buffer);
      const { data, iv } = await encryptBuffer(encryptionKeyRef.current, value.buffer);
      const packet = new Uint8Array(iv.length + data.byteLength);
      packet.set(iv, 0); packet.set(new Uint8Array(data), iv.length);
      dataChannelsRef.current.forEach(dc => { if (dc.readyState === 'open') dc.send(packet); });
      offset += value.byteLength;
      setFiles(prev => prev.map(f => f.id === fileId ? { ...f, progress: Math.round((offset / file.size) * 100) } : f));
    }
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: file.type }));
    setMessages(prev => [...prev, { id: fileId, senderId: 'local', senderName: config.userName, blobUrl, type: file.type.startsWith('image/') ? 'image' : 'file', fileName: file.name, timestamp: Date.now() }]);
    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'completed' } : f));
  };

  const receivingFileRef = useRef<{ id: string; name: string; size: number; received: number; chunks: ArrayBuffer[]; mimeType?: string } | null>(null);
  const handleFileMetaReceive = (meta: any) => {
    receivingFileRef.current = { ...meta, received: 0, chunks: [] };
    setFiles(prev => [{ id: meta.id, name: meta.name, size: meta.size, progress: 0, status: 'transferring', mimeType: meta.mimeType }, ...prev]);
  };

  const handleFileChunkReceive = async (data: ArrayBuffer) => {
    const state = receivingFileRef.current; 
    if (!state || !encryptionKeyRef.current) return;
    try {
      const iv = new Uint8Array(data.slice(0, 12));
      const decryptedChunk = await decryptBuffer(encryptionKeyRef.current, data.slice(12), iv);
      state.chunks.push(decryptedChunk); state.received += decryptedChunk.byteLength;
      setFiles(prev => prev.map(f => f.id === state.id ? { ...f, progress: Math.round((state.received / state.size) * 100) } : f));
      if (state.received >= state.size) {
        const blobUrl = URL.createObjectURL(new Blob(state.chunks, { type: state.mimeType }));
        setMessages(prev => [...prev, { id: state.id, senderId: 'peer', senderName: '对方', blobUrl, type: state.mimeType?.startsWith('image/') ? 'image' : 'file', fileName: state.name, timestamp: Date.now() }]);
        setFiles(prev => prev.map(f => f.id === state.id ? { ...f, status: 'completed' } : f));
        receivingFileRef.current = null;
      }
    } catch (e) { console.error("File decrypt failed", e); }
  };

  const remoteParticipant = participants.find(p => !p.isLocal);
  const localParticipant = participants.find(p => p.isLocal);

  // 控制逻辑
  const toggleMyMic = () => {
    const t = rawStreamRef.current?.getAudioTracks()[0];
    if (t) { t.enabled = !t.enabled; setIsMuted(!t.enabled); }
  };

  const toggleMyPrivacy = () => {
    setCurrentFilter(prev => prev === PrivacyFilter.MOSAIC ? PrivacyFilter.NONE : PrivacyFilter.MOSAIC);
  };

  const toggleMyVideo = () => {
    setCurrentFilter(prev => prev === PrivacyFilter.BLACK ? PrivacyFilter.NONE : PrivacyFilter.BLACK);
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden relative font-sans selection:bg-primary/30">
      <header className="h-12 lg:h-14 shrink-0 flex items-center justify-between px-4 lg:px-6 glass z-[60] m-2 rounded-xl lg:rounded-2xl border-none">
        <div className="flex items-center gap-3">
          <div className="size-8 bg-primary/10 rounded-lg flex items-center justify-center border border-primary/20">
            <span className="material-symbols-outlined text-primary text-sm fill-1">verified_user</span>
          </div>
          <div>
            <h2 className="text-[10px] font-black tracking-widest text-gray-500 uppercase">SERVERLESS SECURE CHANNEL</h2>
            <div className="flex items-center gap-1.5">
               <span className={`size-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-accent shadow-[0_0_8px_#22c55e]' : 'bg-yellow-500 animate-pulse'}`}></span>
               <span className="text-[9px] font-bold text-white uppercase tracking-wider">{connectionStatus.toUpperCase()}</span>
            </div>
          </div>
        </div>
        <button onClick={onExit} className="h-8 px-4 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[10px] font-black uppercase tracking-widest transition-all">物理断开</button>
      </header>

      <main className="flex-1 flex overflow-hidden relative p-2 pt-0">
        <div className="flex-1 flex flex-col relative overflow-hidden bg-black/40 rounded-2xl border border-white/5 shadow-inner">
          {connectionStatus !== 'connected' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-12 space-y-12 animate-in fade-in duration-700">
                {role === 'none' ? (
                    <div className="text-center space-y-12 max-w-2xl">
                        <div className="space-y-4">
                            <h3 className="text-4xl lg:text-6xl font-black text-white tracking-tighter uppercase italic leading-none">身份握手中</h3>
                            <p className="text-gray-500 text-[10px] font-black uppercase tracking-[0.4em]">检测到入场信号，请确认您的节点角色</p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-3xl">
                            <button onClick={startAsInitiator} className="group flex flex-col items-center gap-6 p-10 lg:p-14 glass rounded-[3rem] border-primary/10 hover:border-primary/40 transition-all shadow-xl">
                                <span className="material-symbols-outlined text-5xl text-primary animate-pulse">rocket_launch</span>
                                <h4 className="text-xl font-black text-white uppercase tracking-widest">发起节点</h4>
                            </button>
                            <button onClick={() => setRole('receiver')} className="group flex flex-col items-center gap-6 p-10 lg:p-14 glass rounded-[3rem] border-accent/10 hover:border-accent/40 transition-all shadow-xl">
                                <span className="material-symbols-outlined text-5xl text-accent">join_inner</span>
                                <h4 className="text-xl font-black text-white uppercase tracking-widest">接收节点</h4>
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-3xl relative">
                        <div className={`glass rounded-[3.5rem] p-10 lg:p-16 bg-black/40 border-t-8 transition-all ${role === 'initiator' ? 'border-t-primary' : 'border-t-accent'}`}>
                            {role === 'initiator' ? (
                                <div className="space-y-10 text-center">
                                    {handshakeStep === 2 && (
                                        <div className="space-y-10">
                                            <div className="space-y-4">
                                                <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">第 1 步：复制魔术链接</h4>
                                                <button onClick={() => {navigator.clipboard.writeText(getInviteLink()); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}} className="w-full h-20 bg-primary/10 border-2 border-primary/30 hover:border-primary text-primary rounded-[2rem] font-black uppercase tracking-widest flex items-center justify-center gap-4 transition-all active:scale-95">
                                                    <span className="material-symbols-outlined text-2xl">{isCopied ? 'check_circle' : 'share'}</span>
                                                    <span className="text-lg">{isCopied ? '链接已就绪' : '生成邀请链接'}</span>
                                                </button>
                                            </div>
                                            <div className="space-y-4 text-left">
                                                <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">第 2 步：激活远程节点代码</h4>
                                                <div className="relative">
                                                    <textarea placeholder="粘贴对方返回的代码包..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-32 bg-black/60 border border-white/10 rounded-[2rem] p-6 text-[10px] font-mono text-accent outline-none resize-none" />
                                                    <button onClick={finalizeAsInitiator} disabled={!remoteSDPInput} className="absolute bottom-4 right-4 h-12 px-8 bg-accent text-black rounded-xl font-black uppercase tracking-widest active:scale-95 disabled:opacity-30">连接节点</button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-10">
                                    <div className="space-y-4">
                                        <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">同步初始化请求</h4>
                                        <textarea placeholder="此处粘贴来自发起方的请求代码..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-32 bg-black/60 border border-white/10 rounded-[2rem] p-6 text-[10px] font-mono text-accent outline-none" />
                                        <button onClick={handleOfferAndReply} className="w-full h-16 bg-white/5 border border-white/10 text-white rounded-[2rem] font-black uppercase tracking-widest hover:bg-white/10 transition-all">确认解析并生成响应</button>
                                    </div>
                                    {handshakeStep === 2 && (
                                        <div className="space-y-4">
                                            <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">将响应代码传回对方</h4>
                                            <button onClick={() => {navigator.clipboard.writeText(localSDP); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}} className="w-full h-16 bg-accent text-black rounded-[2rem] font-black uppercase tracking-widest active:scale-95 transition-all">
                                                {isCopied ? '响应包已复制' : '复制响应代码'}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
          ) : (
            <div className="flex-1 relative overflow-hidden bg-black">
              <div className="absolute inset-0 z-0">
                {remoteParticipant ? (
                  <VideoCard participant={remoteParticipant} filter={isRemoteHidden ? PrivacyFilter.BLACK : PrivacyFilter.NONE} isLarge />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center space-y-6 opacity-40">
                    <div className="size-16 rounded-full border-[3px] border-primary/20 border-t-primary animate-spin"></div>
                    <p className="text-xs font-black uppercase tracking-[0.5em] text-white">载荷流建立中...</p>
                  </div>
                )}
              </div>
              <div className="absolute bottom-24 lg:bottom-12 right-4 lg:right-10 w-32 lg:w-64 aspect-video z-50 border-2 border-white/10 rounded-2xl overflow-hidden shadow-2xl">
                {localParticipant && <VideoCard participant={localParticipant} filter={currentFilter} />}
              </div>
            </div>
          )}
        </div>

        <div className={`fixed inset-0 lg:static lg:inset-auto lg:w-96 glass transform transition-all duration-300 z-[110] flex flex-col lg:m-2 lg:rounded-2xl overflow-hidden ${isChatOpen ? 'translate-y-0 opacity-100' : 'translate-y-full lg:hidden opacity-0 pointer-events-none'}`}>
             <div className="h-14 flex items-center justify-between px-6 border-b border-white/5 bg-black/40 shrink-0">
                <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-accent animate-pulse"></span>
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">E2EE 数据隧道</h3>
                </div>
                <button onClick={() => setIsChatOpen(false)} className="size-8 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-500">
                    <span className="material-symbols-outlined text-lg">close</span>
                </button>
             </div>
             <div className="flex-1 overflow-hidden bg-[#080a0c] flex flex-col relative">
                <ChatBox messages={messages} onSend={sendMessage} userName={config.userName} onUpload={handleFileUpload} />
             </div>
        </div>
      </main>

      {/* 优化后的 6 图标控制底栏 */}
      {connectionStatus === 'connected' && (
        <div className="fixed bottom-6 lg:bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-3 lg:gap-6 p-3 glass rounded-[3rem] z-[120] shadow-2xl border border-white/10 animate-in slide-in-from-bottom-10">
          
          {/* 我的控制 (Me) */}
          <div className="flex items-center gap-2 px-1">
            <ControlBtn 
                icon={isMuted ? 'mic_off' : 'mic'} 
                active={!isMuted} 
                onClick={toggleMyMic} 
                danger={isMuted} 
                label="我的声音"
            />
            <ControlBtn 
                icon="grid_view" 
                active={currentFilter === PrivacyFilter.MOSAIC} 
                onClick={toggleMyPrivacy} 
                label="隐私遮蔽"
            />
            <ControlBtn 
                icon={currentFilter === PrivacyFilter.BLACK ? 'videocam_off' : 'videocam'} 
                active={currentFilter !== PrivacyFilter.BLACK} 
                onClick={toggleMyVideo} 
                danger={currentFilter === PrivacyFilter.BLACK}
                label="画面传输"
            />
          </div>

          <div className="w-px h-8 bg-white/10"></div>

          {/* 对方控制 (Remote) */}
          <div className="flex items-center gap-2 px-1">
            <ControlBtn 
                icon={isRemoteMuted ? 'volume_off' : 'volume_up'} 
                active={!isRemoteMuted} 
                onClick={() => setIsRemoteMuted(!isRemoteMuted)} 
                danger={isRemoteMuted}
                label="对方声音"
            />
            <ControlBtn 
                icon={isRemoteHidden ? 'visibility_off' : 'person'} 
                active={!isRemoteHidden} 
                onClick={() => setIsRemoteHidden(!isRemoteHidden)} 
                danger={isRemoteHidden}
                label="对方画面"
            />
          </div>

          <div className="w-px h-8 bg-white/10"></div>

          {/* 辅助功能 */}
          <div className="px-1">
            <ControlBtn icon="forum" active={isChatOpen} onClick={() => setIsChatOpen(!isChatOpen)} label="会话聊天" />
          </div>
        </div>
      )}
    </div>
  );
};

const ControlBtn = ({ icon, active, onClick, danger, label }: { icon: string; active: boolean; onClick: () => void; danger?: boolean; label: string }) => (
  <div className="flex flex-col items-center gap-1.5 group">
    <button 
      onClick={onClick} 
      className={`size-11 lg:size-14 rounded-full flex items-center justify-center transition-all border ${active ? 'bg-primary/10 border-primary/30 text-primary shadow-[0_0_15px_rgba(19,127,236,0.2)]' : (danger ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-white/5 border-white/5 text-gray-500')} hover:scale-105 active:scale-95`}
    >
      <span className="material-symbols-outlined text-[20px] lg:text-[24px]">{icon}</span>
    </button>
    <span className="text-[7px] lg:text-[9px] font-black uppercase text-gray-500 tracking-widest hidden lg:block">{label}</span>
  </div>
);

const ChatBox = ({ messages, onSend, userName, onUpload }: { messages: ChatMessage[]; onSend: (t: string) => void; userName: string; onUpload: (f: File) => void }) => {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages]);
  
  return (
    <div className="flex flex-col h-full relative">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col ${m.senderId === 'local' ? 'items-end' : 'items-start'}`}>
             <span className="text-[8px] font-black text-gray-600 mb-1 px-1 uppercase tracking-widest">{m.senderName}</span>
             <div className={`rounded-2xl max-w-[92%] overflow-hidden shadow-xl ${m.senderId === 'local' ? 'bg-primary text-white rounded-tr-none' : 'bg-white/5 border border-white/10 text-gray-300 rounded-tl-none'}`}>
               {m.type === 'text' && <p className="px-4 py-3 text-xs leading-relaxed break-words">{m.text}</p>}
               {m.blobUrl && (
                 <div className="relative group">
                    {m.type === 'image' ? <img src={m.blobUrl} className="w-full h-auto" /> : <div className="p-4 flex items-center gap-3"><span className="material-symbols-outlined">description</span><span className="text-[10px] truncate">{m.fileName}</span></div>}
                    <a href={m.blobUrl} download={m.fileName} className="absolute bottom-2 right-2 size-8 bg-black/60 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="material-symbols-outlined text-sm">download</span></a>
                 </div>
               )}
             </div>
          </div>
        ))}
      </div>
      <div className="p-4 bg-black/60 border-t border-white/5 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }} className="flex gap-2">
          <label className="shrink-0 size-11 bg-white/5 border border-white/10 text-gray-400 rounded-xl flex items-center justify-center cursor-pointer hover:bg-white/10 transition-all">
              <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
              <span className="material-symbols-outlined text-lg">attach_file</span>
          </label>
          <input className="flex-1 h-11 bg-white/5 border border-white/10 rounded-xl px-4 text-xs text-white focus:outline-none focus:border-primary/50" placeholder="加密消息..." value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" disabled={!text.trim()} className="shrink-0 size-11 bg-primary text-white rounded-xl flex items-center justify-center disabled:opacity-30 active:scale-95 shadow-lg shadow-primary/20"><span className="material-symbols-outlined text-lg">send</span></button>
        </form>
      </div>
    </div>
  );
};

export default Room;
