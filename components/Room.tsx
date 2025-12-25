
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
  
  // Derived state for easy access in JSX
  const localParticipant = participants.find(p => p.isLocal);
  const remoteParticipant = participants.find(p => !p.isLocal);

  const [role, setRole] = useState<HandshakeRole>(config.initialOffer ? 'receiver' : 'none');
  const [localSDP, setLocalSDP] = useState('');
  const [remoteSDPInput, setRemoteSDPInput] = useState(config.initialOffer || '');
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'preparing' | 'ready' | 'connected'>('idle');
  const [handshakeStep, setHandshakeStep] = useState(1);
  const [handshakeTimer, setHandshakeTimer] = useState(180);

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

  // Handshake timer logic
  useEffect(() => {
    let timer: number;
    if (role !== 'none' && connectionStatus !== 'connected' && handshakeTimer > 0) {
      timer = window.setInterval(() => {
        setHandshakeTimer(prev => prev - 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [role, connectionStatus, handshakeTimer]);

  // Automatic Handshake execution for Receivers arriving via Link
  useEffect(() => {
    if (config.initialOffer && role === 'receiver' && connectionStatus === 'idle') {
      console.log("Detecting initial offer, starting auto-reply...");
      handleOfferAndReply();
    }
  }, [config.initialOffer]);

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

  // Filter engine for Mosaic/Blur
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
          const scale = 0.02; 
          const w = canvas.width * scale;
          const h = canvas.height * scale;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(video, 0, 0, w, h);
          ctx.filter = 'blur(12px)'; 
          ctx.drawImage(canvas, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
          ctx.filter = 'none';
        } else if (filter === PrivacyFilter.BLUR) {
          ctx.filter = 'blur(60px)';
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
    // Enhanced STUN configuration for better NAT traversal
    const pc = new RTCPeerConnection({ 
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    });
    
    peersRef.current.set(remoteId, pc);
    processedStreamRef.current?.getTracks().forEach(track => { 
      if (processedStreamRef.current) pc.addTrack(track, processedStreamRef.current); 
    });
    
    pc.ontrack = (e) => { 
      addParticipant({ id: remoteId, name: "远端节点", isLocal: false, isHost: false, audioEnabled: true, videoEnabled: true, stream: e.streams[0] }); 
    };
    
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setConnectionStatus('connected');
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) removeParticipant(remoteId);
    };
    
    if (isOffer) {
      const dc = pc.createDataChannel('secure-chat-tunnel', { ordered: true });
      setupDataChannel(remoteId, dc);
    } else { 
      pc.ondatachannel = (e) => setupDataChannel(remoteId, e.channel); 
    }
    
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
    } catch (e) { alert("握手包格式错误"); }
  };

  const handleOfferAndReply = async () => {
    const offerToProcess = config.initialOffer || remoteSDPInput;
    if (!offerToProcess) return;
    try {
      const decoded = JSON.parse(atob(offerToProcess));
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
    } catch (e) { 
        console.error("Handshake auto-reply failed", e);
        if (!config.initialOffer) alert("请求解析失败，请检查代码包"); 
    }
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

  const resetHandshake = () => {
    window.location.reload();
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden relative font-sans">
      <header className="h-12 lg:h-14 shrink-0 flex items-center justify-between px-3 lg:px-6 glass z-[60] m-2 rounded-xl lg:rounded-2xl border-none">
        <div className="flex items-center gap-2 lg:gap-3">
          <div className="size-7 lg:size-8 bg-primary/10 rounded-lg flex items-center justify-center border border-primary/20">
            <span className="material-symbols-outlined text-primary text-xs lg:text-sm fill-1">verified_user</span>
          </div>
          <div className="flex flex-col">
            <h2 className="text-[8px] lg:text-[10px] font-black tracking-widest text-gray-500 uppercase">PRIVATE CHANNEL</h2>
            <div className="flex items-center gap-1.5">
               <span className={`size-1 lg:size-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-accent shadow-[0_0_8px_#22c55e]' : 'bg-yellow-500 animate-pulse'}`}></span>
               <span className="text-[8px] lg:text-[9px] font-bold text-white uppercase tracking-wider">{connectionStatus.toUpperCase()}</span>
            </div>
          </div>
        </div>
        <button onClick={onExit} className="h-7 lg:h-8 px-3 lg:px-4 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[8px] lg:text-[10px] font-black uppercase tracking-widest transition-all">物理退出</button>
      </header>

      <main className="flex-1 flex overflow-hidden relative p-2 pt-0 gap-2">
        <div className="flex-1 flex flex-col relative overflow-hidden bg-black/60 rounded-2xl border border-white/5 shadow-inner">
          {connectionStatus !== 'connected' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-12 space-y-6 animate-in fade-in duration-700 overflow-y-auto">
                {role === 'none' ? (
                    <div className="text-center space-y-8 lg:space-y-12 max-w-2xl w-full px-4">
                        <div className="space-y-3">
                            <h3 className="text-3xl lg:text-5xl font-black text-white tracking-tighter uppercase italic leading-none">节点待命中</h3>
                            <p className="text-gray-500 text-[9px] lg:text-[10px] font-black uppercase tracking-[0.4em]">请选择您的连接策略</p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6 w-full max-w-3xl">
                            <button onClick={startAsInitiator} className="group flex flex-col items-center gap-4 lg:gap-8 p-6 lg:p-14 glass rounded-[2rem] lg:rounded-[3rem] border-primary/10 hover:border-primary/40 transition-all shadow-xl active:scale-95">
                                <span className="material-symbols-outlined text-4xl lg:text-5xl text-primary animate-pulse">send_time_extension</span>
                                <h4 className="text-sm lg:text-xl font-black text-white uppercase tracking-widest">作为发起方</h4>
                            </button>
                            <button onClick={() => setRole('receiver')} className="group flex flex-col items-center gap-4 lg:gap-8 p-6 lg:p-14 glass rounded-[2rem] lg:rounded-[3rem] border-accent/10 hover:border-accent/40 transition-all shadow-xl active:scale-95">
                                <span className="material-symbols-outlined text-4xl lg:text-5xl text-accent">hail</span>
                                <h4 className="text-sm lg:text-xl font-black text-white uppercase tracking-widest">作为接收方</h4>
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-3xl relative px-4">
                        <div className={`glass rounded-[2rem] lg:rounded-[3.5rem] p-6 lg:p-14 bg-black/80 border-t-8 transition-all ${role === 'initiator' ? 'border-t-primary' : 'border-t-accent'}`}>
                            
                            {/* 握手倒计时显示 */}
                            <div className="flex items-center justify-between mb-8 opacity-60">
                                <div className="flex items-center gap-2">
                                    <span className="material-symbols-outlined text-sm animate-spin-slow">history</span>
                                    <span className="text-[10px] font-mono font-bold uppercase tracking-widest">握手窗口</span>
                                </div>
                                <span className={`text-sm font-mono font-black ${handshakeTimer < 30 ? 'text-red-500 animate-pulse' : 'text-primary'}`}>
                                    {Math.floor(handshakeTimer / 60)}:{(handshakeTimer % 60).toString().padStart(2, '0')}
                                </span>
                            </div>

                            {role === 'initiator' ? (
                                <div className="space-y-6 text-center">
                                    {handshakeStep === 2 && (
                                        <div className="space-y-8">
                                            <div className="space-y-4">
                                                <h4 className="text-[10px] lg:text-[11px] font-black text-white uppercase tracking-[0.2em] text-left">STEP 1: 发送魔术链接</h4>
                                                <button onClick={() => {navigator.clipboard.writeText(getInviteLink()); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}} className="w-full h-14 lg:h-18 bg-primary/10 border-2 border-primary/20 hover:border-primary text-primary rounded-2xl lg:rounded-[1.5rem] font-black uppercase tracking-widest flex items-center justify-center gap-3 transition-all active:scale-95">
                                                    <span className="material-symbols-outlined text-xl">{isCopied ? 'done_all' : 'content_copy'}</span>
                                                    <span className="text-sm">{isCopied ? '已准备好发送' : '复制连接请求'}</span>
                                                </button>
                                            </div>
                                            <div className="space-y-4 text-left">
                                                <h4 className="text-[10px] lg:text-[11px] font-black text-white uppercase tracking-[0.2em]">STEP 2: 注入对方代码包</h4>
                                                <div className="relative">
                                                    <textarea placeholder="粘贴对方生成的握手包..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-24 lg:h-32 bg-black/40 border border-white/5 rounded-2xl p-4 lg:p-6 text-[10px] font-mono text-accent outline-none resize-none placeholder:opacity-30" />
                                                    <button onClick={finalizeAsInitiator} disabled={!remoteSDPInput} className="absolute bottom-3 right-3 h-10 px-6 bg-accent text-black rounded-xl text-[10px] font-black uppercase tracking-widest active:scale-95 disabled:opacity-20 transition-all">建立隧道</button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-8">
                                    <div className="space-y-4">
                                        <h4 className="text-[10px] lg:text-[11px] font-black text-white uppercase tracking-[0.2em]">待同步请求包</h4>
                                        <textarea placeholder="粘贴发起方的请求代码..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-24 lg:h-32 bg-black/40 border border-white/5 rounded-2xl p-4 lg:p-6 text-[10px] font-mono text-accent outline-none resize-none placeholder:opacity-30" />
                                        <button onClick={handleOfferAndReply} className="w-full h-14 bg-white/5 border border-white/10 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all">计算响应包</button>
                                    </div>
                                    {handshakeStep === 2 && (
                                        <div className="space-y-4">
                                            <h4 className="text-[10px] lg:text-[11px] font-black text-white uppercase tracking-[0.2em]">将响应代码传回对方</h4>
                                            <button onClick={() => {navigator.clipboard.writeText(localSDP); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}} className="w-full h-14 bg-accent text-black rounded-2xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all">
                                                {isCopied ? '响应已复制到剪贴板' : '复制我的响应代码'}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {handshakeTimer === 0 && (
                                <div className="mt-8 pt-8 border-t border-white/5 text-center space-y-4 animate-in fade-in slide-in-from-bottom-2">
                                    <p className="text-[10px] text-red-400 font-bold uppercase tracking-widest">握手时间已耗尽，请确保双方环境畅通</p>
                                    <button onClick={resetHandshake} className="px-6 py-2 bg-white/5 border border-white/10 rounded-full text-[9px] font-black uppercase tracking-widest text-gray-400 hover:text-white transition-colors">重置节点</button>
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
                  <div className="w-full h-full flex flex-col items-center justify-center space-y-6 opacity-30">
                    <div className="size-12 lg:size-16 rounded-full border-4 border-primary/10 border-t-primary animate-spin"></div>
                    <p className="text-[10px] lg:text-xs font-black uppercase tracking-[0.4em] text-white">正在加密数据链路...</p>
                  </div>
                )}
              </div>
              <div className="absolute bottom-20 lg:bottom-8 right-3 lg:right-8 w-28 lg:w-64 aspect-video z-50 border-2 border-white/20 rounded-xl lg:rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.5)]">
                {localParticipant && <VideoCard participant={localParticipant} filter={currentFilter} />}
              </div>
            </div>
          )}
        </div>

        {/* 侧边聊天栏 - 移动端全屏 Overlay, 桌面端侧边栏 */}
        <div className={`fixed inset-0 lg:static lg:inset-auto lg:w-[420px] glass transform transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] z-[200] flex flex-col lg:rounded-2xl overflow-hidden ${isChatOpen ? 'translate-y-0 opacity-100' : 'translate-y-full lg:hidden opacity-0 pointer-events-none'}`}>
             <div className="h-14 flex items-center justify-between px-6 border-b border-white/5 bg-black/90 shrink-0">
                <div className="flex items-center gap-2.5">
                    <span className="size-2 rounded-full bg-accent animate-pulse shadow-[0_0_8px_#22c55e]"></span>
                    <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-white/90">加密通讯隧道</h3>
                </div>
                <button onClick={() => setIsChatOpen(false)} className="size-10 rounded-full hover:bg-white/5 flex items-center justify-center text-gray-500 transition-all active:scale-90">
                    <span className="material-symbols-outlined text-2xl">close</span>
                </button>
             </div>
             <div className="flex-1 overflow-hidden bg-[#0a0c0e] flex flex-col relative">
                <ChatBox messages={messages} onSend={sendMessage} userName={config.userName} onUpload={handleFileUpload} />
             </div>
        </div>
      </main>

      {/* 优化后的控制底栏 */}
      {connectionStatus === 'connected' && (
        <div className="fixed bottom-4 lg:bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-1.5 lg:gap-8 p-2 lg:p-4 glass rounded-[2.5rem] lg:rounded-[3.5rem] z-[120] shadow-[0_30px_60px_-15px_rgba(0,0,0,0.8)] border border-white/10 animate-in slide-in-from-bottom-8">
          <div className="flex items-center gap-1 lg:gap-3 px-1.5">
            <ControlBtn icon={isMuted ? 'mic_off' : 'mic'} active={!isMuted} onClick={toggleMyMic} danger={isMuted} label="静音" />
            <ControlBtn icon="blur_on" active={currentFilter === PrivacyFilter.MOSAIC} onClick={toggleMyPrivacy} label="马赛克" />
            <ControlBtn icon={currentFilter === PrivacyFilter.BLACK ? 'visibility_off' : 'videocam'} active={currentFilter !== PrivacyFilter.BLACK} onClick={toggleMyVideo} danger={currentFilter === PrivacyFilter.BLACK} label="屏闭画面" />
          </div>
          <div className="w-px h-8 bg-white/10 mx-1"></div>
          <div className="flex items-center gap-1 lg:gap-3 px-1.5">
            <ControlBtn icon={isRemoteMuted ? 'volume_off' : 'volume_up'} active={!isRemoteMuted} onClick={() => setIsRemoteMuted(!isRemoteMuted)} danger={isRemoteMuted} label="对方声音" />
            <ControlBtn icon={isRemoteHidden ? 'hide' : 'person'} active={!isRemoteHidden} onClick={() => setIsRemoteHidden(!isRemoteHidden)} danger={isRemoteHidden} label="隐藏对方" />
          </div>
          <div className="w-px h-8 bg-white/10 mx-1"></div>
          <div className="px-1.5">
            <ControlBtn icon="forum" active={isChatOpen} onClick={() => setIsChatOpen(!isChatOpen)} label="消息" badge={messages.length > 0} />
          </div>
        </div>
      )}
    </div>
  );
};

const ControlBtn = ({ icon, active, onClick, danger, label, badge }: { icon: string; active: boolean; onClick: () => void; danger?: boolean; label: string; badge?: boolean }) => (
  <div className="flex flex-col items-center gap-1.5 group">
    <button 
      onClick={onClick} 
      className={`relative size-10 lg:size-14 rounded-full flex items-center justify-center transition-all border ${active ? 'bg-primary/10 border-primary/30 text-primary shadow-[0_0_15px_rgba(19,127,236,0.15)]' : (danger ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-white/5 border-white/5 text-gray-500')} hover:scale-110 active:scale-90`}
    >
      <span className="material-symbols-outlined text-[20px] lg:text-[26px]">{icon}</span>
      {badge && <span className="absolute top-0 right-0 size-2 bg-primary rounded-full ring-2 ring-black"></span>}
    </button>
    <span className="text-[7px] lg:text-[10px] font-black uppercase text-gray-600 tracking-tighter hidden md:block">{label}</span>
  </div>
);

const ChatBox = ({ messages, onSend, userName, onUpload }: { messages: ChatMessage[]; onSend: (t: string) => void; userName: string; onUpload: (f: File) => void }) => {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  useEffect(() => { 
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      onSend(text);
      setText('');
      if (window.innerWidth > 1024) inputRef.current?.focus();
    }
  };
  
  return (
    <div className="flex flex-col h-full relative overflow-hidden bg-[#080a0c]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6 custom-scrollbar pb-36 lg:pb-10">
        {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center opacity-20 space-y-4 py-20 grayscale">
                <div className="size-20 rounded-full bg-white/5 flex items-center justify-center border border-white/10">
                    <span className="material-symbols-outlined text-5xl">vpn_lock</span>
                </div>
                <div className="space-y-1 px-10">
                    <p className="text-[11px] font-black uppercase tracking-[0.4em]">端对端加密通道</p>
                    <p className="text-[9px] font-medium leading-relaxed">消息仅通过 P2P 隧道传输，关闭即物理抹除</p>
                </div>
            </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col ${m.senderId === 'local' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-4`}>
             <div className="flex items-center gap-2 mb-1.5 px-1.5">
                <span className={`text-[9px] font-black uppercase tracking-widest ${m.senderId === 'local' ? 'text-primary' : 'text-gray-500'}`}>{m.senderName}</span>
                <span className="text-[7px] font-mono text-gray-700">{new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
             </div>
             <div className={`rounded-2xl max-w-[90%] lg:max-w-[85%] overflow-hidden shadow-2xl transition-all hover:scale-[1.01] ${m.senderId === 'local' ? 'bg-primary text-white rounded-tr-none' : 'bg-[#1a1f26] border border-white/10 text-gray-200 rounded-tl-none'}`}>
               {m.type === 'text' && <p className="px-4 py-3 lg:px-5 lg:py-3.5 text-[13px] lg:text-[14px] leading-relaxed break-words font-medium">{m.text}</p>}
               {m.blobUrl && (
                 <div className="relative group min-w-[180px]">
                    {m.type === 'image' ? (
                        <img src={m.blobUrl} className="w-full h-auto max-h-[500px] object-cover" loading="lazy" />
                    ) : (
                        <div className="p-4 lg:p-5 flex items-center gap-4 bg-black/20">
                            <div className="size-11 rounded-xl bg-white/5 flex items-center justify-center border border-white/10">
                                <span className="material-symbols-outlined text-xl">lab_profile</span>
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-[11px] font-bold truncate pr-6 text-white">{m.fileName}</span>
                                <span className="text-[8px] opacity-40 uppercase tracking-widest mt-0.5">Verified E2EE Data</span>
                            </div>
                        </div>
                    )}
                    <a href={m.blobUrl} download={m.fileName} className="absolute bottom-2 right-2 size-10 bg-black/80 rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 lg:opacity-0 transition-opacity backdrop-blur-md border border-white/10 active:scale-90">
                        <span className="material-symbols-outlined text-lg text-white">download</span>
                    </a>
                 </div>
               )}
             </div>
          </div>
        ))}
      </div>
      
      {/* 针对移动端优化的高度 */}
      <div className="absolute bottom-0 inset-x-0 p-4 lg:p-6 bg-gradient-to-t from-black via-black/95 to-transparent backdrop-blur-sm border-t border-white/5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <form onSubmit={handleSubmit} className="flex gap-3 max-w-4xl mx-auto">
          <label className="shrink-0 size-12 bg-white/5 border border-white/10 text-gray-400 rounded-xl flex items-center justify-center cursor-pointer hover:bg-white/10 active:scale-95 transition-all">
              <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
              <span className="material-symbols-outlined text-2xl">add_photo_alternate</span>
          </label>
          <div className="flex-1 relative">
            <input 
              ref={inputRef}
              className="w-full h-12 bg-white/5 border border-white/10 rounded-xl px-5 text-[13px] text-white placeholder:text-gray-600 focus:outline-none focus:border-primary/50 focus:bg-white/[0.08] transition-all shadow-inner" 
              placeholder="加密消息流..." 
              value={text} 
              onChange={(e) => setText(e.target.value)} 
            />
          </div>
          <button type="submit" disabled={!text.trim()} className="shrink-0 size-12 bg-primary text-white rounded-xl flex items-center justify-center disabled:opacity-20 active:scale-95 shadow-xl shadow-primary/30 transition-all">
            <span className="material-symbols-outlined text-2xl">arrow_upward</span>
          </button>
        </form>
      </div>
    </div>
  );
};

export default Room;
