
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
  const [isVideoOff, setIsVideoOff] = useState(false);
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
  
  // 用于流处理的引用
  const rawStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const filterCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const filterRef = useRef<PrivacyFilter>(config.defaultFilter);

  // 同步 filter 到 ref 供渲染循环使用
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

  // 渲染处理循环：将滤镜应用到发送流中
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
          ctx.filter = 'blur(30px)';
          ctx.drawImage(video, 0, 0);
          ctx.filter = 'none';
        } else {
          ctx.drawImage(video, 0, 0);
        }
      }
      animationFrame = requestAnimationFrame(render);
    };

    if (rawStreamRef.current) {
      video.srcObject = rawStreamRef.current;
      video.play().then(() => {
        render();
      });
    }

    return () => {
      cancelAnimationFrame(animationFrame);
      video.pause();
      video.srcObject = null;
    };
  }, []);

  useEffect(() => {
    let timer: number;
    if (role !== 'none' && connectionStatus !== 'connected' && countdown > 0) {
      timer = window.setInterval(() => setCountdown(prev => prev - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [role, connectionStatus, countdown]);

  useEffect(() => {
    const init = async () => {
      encryptionKeyRef.current = await deriveKey(config.passphrase, config.roomId);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }, 
          audio: true 
        });
        rawStreamRef.current = stream;

        // 创建处理后的流
        const canvasStream = (filterCanvasRef.current as any).captureStream(30);
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) canvasStream.addTrack(audioTrack);
        processedStreamRef.current = canvasStream;

        addParticipant({ id: 'local', name: config.userName, isLocal: true, isHost: true, audioEnabled: true, videoEnabled: true, stream: canvasStream });
      } catch (err) { 
        console.error("Media access error:", err); 
      }

      const hash = window.location.hash;
      if (hash.includes('offer=')) {
        const params = new URLSearchParams(hash.substring(1));
        const offerData = params.get('offer');
        if (offerData) {
          setRemoteSDPInput(offerData);
          setRole('receiver');
          setTimeout(() => {
            const parseBtn = document.getElementById('auto-action-trigger');
            if (parseBtn) parseBtn.click();
          }, 1200);
        }
      }
    };
    init();
    return () => {
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
      dataChannelsRef.current.clear();
      rawStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [config.roomId, config.userName, config.passphrase, addParticipant]);

  const setupPeerConnection = async (remoteId: string, isOffer: boolean): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peersRef.current.set(remoteId, pc);
    
    // 发送处理后的流（带滤镜的流）
    processedStreamRef.current?.getTracks().forEach(track => { 
      if (processedStreamRef.current) pc.addTrack(track, processedStreamRef.current); 
    });

    pc.ontrack = (e) => { 
      addParticipant({ id: remoteId, name: "对方节点", isLocal: false, isHost: false, audioEnabled: true, videoEnabled: true, stream: e.streams[0] }); 
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setConnectionStatus('connected');
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        removeParticipant(remoteId);
        if (peersRef.current.size === 0) {
          setConnectionStatus('idle'); setRole('none'); setLocalSDP(''); setRemoteSDPInput(''); setHandshakeStep(1); window.location.hash = ''; setCountdown(180);
        }
      }
    };

    if (isOffer) {
      const dc = pc.createDataChannel('secure-chat', { ordered: true });
      setupDataChannel(remoteId, dc);
    } else { 
      pc.ondatachannel = (e) => setupDataChannel(remoteId, e.channel); 
    }
    return pc;
  };

  const setupDataChannel = (remoteId: string, dc: RTCDataChannel) => {
    dataChannelsRef.current.set(remoteId, dc);
    dc.onopen = () => console.log("Data channel opened with", remoteId);
    dc.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'chat' && encryptionKeyRef.current) {
            const text = await decryptMessage(encryptionKeyRef.current, payload.data, payload.iv);
            setMessages(prev => [...prev, { id: Date.now().toString(), senderId: remoteId, senderName: '对方', text, type: 'text', timestamp: Date.now() }]);
          } else if (payload.type === 'file-meta') {
            handleFileMetaReceive(payload);
          }
        } catch (err) { 
          console.error("Payload error:", err); 
        }
      } else {
        handleFileChunkReceive(e.data);
      }
    };
  };

  const startAsInitiator = async () => {
    setRole('initiator'); 
    setConnectionStatus('preparing');
    const pc = await setupPeerConnection('peer', true);
    const offer = await pc.createOffer(); 
    await pc.setLocalDescription(offer);
    const onIceComplete = () => {
      if (pc.iceGatheringState === 'complete') {
        const sdp = btoa(JSON.stringify(pc.localDescription));
        setLocalSDP(sdp); 
        setConnectionStatus('ready'); 
        setHandshakeStep(2);
      }
    };
    pc.onicegatheringstatechange = onIceComplete;
    if (pc.iceGatheringState === 'complete') onIceComplete();
  };

  const finalizeAsInitiator = async () => {
    if (!remoteSDPInput) return;
    try {
      const decoded = JSON.parse(atob(remoteSDPInput));
      const pc = peersRef.current.get('peer');
      if (pc && decoded.type === 'answer') await pc.setRemoteDescription(new RTCSessionDescription(decoded));
    } catch (e) { alert("Answer 解析失败"); }
  };

  const handleOfferAndReply = async () => {
    if (!remoteSDPInput) return;
    try {
      const decoded = JSON.parse(atob(remoteSDPInput));
      if (decoded.type !== 'offer') return;
      setConnectionStatus('preparing');
      const pc = await setupPeerConnection('peer', false);
      await pc.setRemoteDescription(new RTCSessionDescription(decoded));
      const answer = await pc.createAnswer(); 
      await pc.setLocalDescription(answer);
      const onIceComplete = () => {
        if (pc.iceGatheringState === 'complete') {
          setLocalSDP(btoa(JSON.stringify(pc.localDescription))); 
          setConnectionStatus('ready'); 
          setHandshakeStep(2);
        }
      };
      pc.onicegatheringstatechange = onIceComplete;
      if (pc.iceGatheringState === 'complete') onIceComplete();
    } catch (e) { alert("Offer 解析失败"); }
  };

  const getInviteLink = () => {
    const url = new URL(window.location.href.split('#')[0]);
    url.hash = `room=${config.roomId}&pass=${config.passphrase}&offer=${localSDP}`;
    return url.toString();
  };

  const sendMessage = async (text: string) => {
    if (!encryptionKeyRef.current) return;
    const encrypted = await encryptMessage(encryptionKeyRef.current, text);
    const payload = JSON.stringify({ type: 'chat', ...encrypted });
    let sent = false;
    dataChannelsRef.current.forEach(dc => { 
      if (dc.readyState === 'open') {
        dc.send(payload); 
        sent = true;
      }
    });
    if (sent) {
      setMessages(prev => [...prev, { id: Date.now().toString(), senderId: 'local', senderName: config.userName, text, type: 'text', timestamp: Date.now() }]);
    } else {
      console.warn("No open data channel to send message");
    }
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
      packet.set(iv, 0); 
      packet.set(new Uint8Array(data), iv.length);
      dataChannelsRef.current.forEach(dc => { if (dc.readyState === 'open') dc.send(packet); });
      offset += value.byteLength;
      setFiles(prev => prev.map(f => f.id === fileId ? { ...f, progress: Math.round((offset / file.size) * 100) } : f));
    }
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: file.type }));
    const type: MessageType = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
    setMessages(prev => [...prev, { id: fileId, senderId: 'local', senderName: config.userName, blobUrl, type, fileName: file.name, timestamp: Date.now() }]);
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
      const encryptedData = data.slice(12);
      const decryptedChunk = await decryptBuffer(encryptionKeyRef.current, encryptedData, iv);
      state.chunks.push(decryptedChunk); 
      state.received += decryptedChunk.byteLength;
      const progress = Math.round((state.received / state.size) * 100);
      setFiles(prev => prev.map(f => f.id === state.id ? { ...f, progress } : f));
      if (state.received >= state.size) {
        const blob = new Blob(state.chunks, { type: state.mimeType });
        const blobUrl = URL.createObjectURL(blob);
        const type: MessageType = state.mimeType?.startsWith('image/') ? 'image' : state.mimeType?.startsWith('video/') ? 'video' : 'file';
        setMessages(prev => [...prev, { id: state.id, senderId: 'peer', senderName: '对方', blobUrl, type, fileName: state.name, timestamp: Date.now() }]);
        setFiles(prev => prev.map(f => f.id === state.id ? { ...f, status: 'completed' } : f));
        receivingFileRef.current = null;
      }
    } catch (e) { console.error("Decryption error:", e); }
  };

  const remoteParticipant = participants.find(p => !p.isLocal);
  const localParticipant = participants.find(p => p.isLocal);

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
        <button onClick={onExit} className="h-8 px-4 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[10px] font-black uppercase tracking-widest transition-all">物理切断</button>
      </header>

      <main className="flex-1 flex overflow-hidden relative p-2 pt-0">
        <div className="flex-1 flex flex-col relative overflow-hidden bg-black/40 rounded-2xl border border-white/5">
          {connectionStatus !== 'connected' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-12 space-y-12 animate-in fade-in duration-700">
                {role === 'none' ? (
                    <div className="text-center space-y-12 max-w-2xl animate-in zoom-in-95">
                        <div className="space-y-4">
                            <h3 className="text-4xl lg:text-6xl font-black text-white tracking-tighter uppercase italic leading-none">身份握手中</h3>
                            <p className="text-gray-500 text-xs font-black uppercase tracking-[0.4em]">检测到入场信号，请确认您的节点身份</p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-3xl">
                            <button onClick={startAsInitiator} className="group flex flex-col items-center gap-6 p-10 lg:p-14 glass rounded-[3rem] border-primary/10 hover:border-primary/40 transition-all active:scale-95 shadow-xl">
                                <span className="material-symbols-outlined text-5xl text-primary animate-pulse">rocket_launch</span>
                                <h4 className="text-xl font-black text-white uppercase tracking-widest">节点发起者</h4>
                            </button>
                            <button onClick={() => setRole('receiver')} className="group flex flex-col items-center gap-6 p-10 lg:p-14 glass rounded-[3rem] border-accent/10 hover:border-accent/40 transition-all active:scale-95 shadow-xl">
                                <span className="material-symbols-outlined text-5xl text-accent">join_inner</span>
                                <h4 className="text-xl font-black text-white uppercase tracking-widest">节点接收者</h4>
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-3xl animate-in slide-in-from-bottom-10 relative">
                        <div className="absolute -top-16 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-white/5 px-6 py-2 rounded-full border border-white/5">
                            <span className="material-symbols-outlined text-sm text-gray-500">timer</span>
                            <span className="text-xs font-mono font-black text-white">
                                {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}
                            </span>
                            <span className="text-[8px] text-gray-500 uppercase tracking-widest">握手期限</span>
                        </div>

                        <div className={`glass rounded-[3.5rem] p-10 lg:p-16 bg-black/40 border-t-8 transition-all ${role === 'initiator' ? 'border-t-primary' : 'border-t-accent'}`}>
                            {role === 'initiator' ? (
                                <div className="space-y-10 text-center">
                                    {handshakeStep === 2 && (
                                        <div className="space-y-10 animate-in zoom-in-95">
                                            <div className="space-y-4">
                                                <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">第 1 步：分发魔术链接</h4>
                                                <button onClick={() => {navigator.clipboard.writeText(getInviteLink()); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}} className="w-full h-20 bg-primary/10 border-2 border-primary/30 hover:border-primary text-primary rounded-[2rem] font-black uppercase tracking-widest flex items-center justify-center gap-4 transition-all shadow-xl active:scale-95">
                                                    <span className="material-symbols-outlined text-2xl">{isCopied ? 'check_circle' : 'share'}</span>
                                                    <span className="text-lg">{isCopied ? '魔术链接已就绪' : '复制安全邀请链接'}</span>
                                                </button>
                                            </div>
                                            <div className="space-y-4 text-left">
                                                <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">第 2 步：激活远程节点</h4>
                                                <div className="relative">
                                                    <textarea placeholder="粘贴对方返回的代码..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-32 bg-black/60 border border-white/10 rounded-[2rem] p-6 text-[10px] font-mono text-accent outline-none resize-none transition-all" />
                                                    <button onClick={finalizeAsInitiator} disabled={!remoteSDPInput} className="absolute bottom-4 right-4 h-12 px-8 bg-accent text-black rounded-xl font-black uppercase tracking-widest active:scale-95 disabled:opacity-30">激活连接</button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-10">
                                    <div className="space-y-4">
                                        <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">同步 Offer 数据包</h4>
                                        <textarea placeholder="此处粘贴来自发起方的 Offer..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-32 bg-black/60 border border-white/10 rounded-[2rem] p-6 text-[10px] font-mono text-accent outline-none focus:border-accent/40" />
                                        <button id="auto-action-trigger" onClick={handleOfferAndReply} className="w-full h-16 bg-white/5 border border-white/10 text-white rounded-[2rem] font-black uppercase tracking-widest hover:bg-white/10 active:scale-95 transition-all">确认并生成响应</button>
                                    </div>
                                    {handshakeStep === 2 && (
                                        <div className="space-y-4 animate-in slide-in-from-top-4">
                                            <h4 className="text-[11px] font-black text-white uppercase tracking-widest px-2">将响应代码传回对方</h4>
                                            <button onClick={() => {navigator.clipboard.writeText(localSDP); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}} className="w-full h-16 bg-accent text-black rounded-[2rem] font-black uppercase tracking-widest shadow-xl shadow-accent/20 active:scale-95 transition-all">
                                                {isCopied ? '响应代码已复制' : '复制响应代码'}
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
            <div className="flex-1 relative overflow-hidden group/room">
              {/* 主要画面：对方 (全屏) */}
              <div className="absolute inset-0 z-0 bg-black">
                {remoteParticipant ? (
                  <VideoCard participant={remoteParticipant} filter={PrivacyFilter.NONE} isLarge />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center space-y-6 opacity-60">
                    <div className="size-16 rounded-full border-[3px] border-primary/20 border-t-primary animate-spin"></div>
                    <p className="text-xs font-black uppercase tracking-[0.5em] text-white">等待对方流介入</p>
                  </div>
                )}
              </div>

              {/* 悬浮画面：自己 (带滤镜) */}
              <div className="absolute bottom-6 left-6 w-48 lg:w-72 aspect-video z-50 transition-all duration-500 hover:scale-[1.03] border-2 border-white/10 rounded-[1.5rem] lg:rounded-[2rem] overflow-hidden shadow-2xl shadow-black/90">
                {localParticipant && (
                  <VideoCard participant={localParticipant} filter={currentFilter} />
                )}
                <div className="absolute top-3 left-3 px-2 py-0.5 bg-black/60 backdrop-blur-md rounded-md text-[8px] font-black text-white uppercase tracking-widest">
                  本地加密预览
                </div>
              </div>
            </div>
          )}
        </div>

        {/* E2EE 聊天 & 文件隧道 */}
        <div className={`fixed inset-0 lg:static lg:inset-auto lg:w-96 glass transform transition-all duration-300 z-[110] flex flex-col lg:m-2 lg:rounded-2xl overflow-hidden ${isChatOpen ? 'translate-y-0 opacity-100' : 'translate-y-full lg:hidden opacity-0 scale-95 pointer-events-none'}`}>
             <div className="h-14 flex items-center justify-between px-6 border-b border-white/5 bg-black/40 shrink-0">
                <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-accent animate-pulse shadow-[0_0_8px_#22c55e]"></span>
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">E2EE 数据隧道</h3>
                </div>
                <button onClick={() => setIsChatOpen(false)} className="size-8 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-lg text-gray-500">close</span>
                </button>
             </div>
             <div className="flex-1 overflow-hidden bg-[#080a0c] flex flex-col relative group/chat">
                <ChatBox messages={messages} onSend={sendMessage} userName={config.userName} onUpload={handleFileUpload} />
             </div>
        </div>
      </main>

      {/* 控制底栏 */}
      {connectionStatus === 'connected' && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3 p-3 glass rounded-[2rem] z-[100] shadow-2xl shadow-black animate-in slide-in-from-bottom-10">
          <div className="flex items-center gap-1 bg-white/5 p-1 rounded-2xl mr-2">
              <FilterBtn active={currentFilter === PrivacyFilter.NONE} icon="visibility" onClick={() => setCurrentFilter(PrivacyFilter.NONE)} />
              <FilterBtn active={currentFilter === PrivacyFilter.MOSAIC} icon="grid_view" onClick={() => setCurrentFilter(PrivacyFilter.MOSAIC)} />
              <FilterBtn active={currentFilter === PrivacyFilter.BLACK} icon="videocam_off" onClick={() => setCurrentFilter(PrivacyFilter.BLACK)} />
          </div>
          <ControlBtn icon={isMuted ? 'mic_off' : 'mic'} active={!isMuted} onClick={() => { const t = rawStreamRef.current?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; setIsMuted(!t.enabled); } }} danger={isMuted} />
          <ControlBtn icon={isVideoOff ? 'videocam_off' : 'videocam'} active={!isVideoOff} onClick={() => { const t = rawStreamRef.current?.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; setIsVideoOff(!t.enabled); } }} danger={isVideoOff} />
          <div className="w-px h-6 bg-white/10 mx-1"></div>
          <ControlBtn icon="forum" active={isChatOpen} onClick={() => setIsChatOpen(true)} />
        </div>
      )}
    </div>
  );
};

const FilterBtn = ({ active, icon, onClick }: { active: boolean; icon: string; onClick: () => void }) => (
  <button onClick={onClick} className={`size-8 rounded-lg flex items-center justify-center transition-all ${active ? 'bg-primary text-white shadow-lg' : 'text-gray-500 hover:text-white hover:bg-white/10'}`}>
    <span className="material-symbols-outlined text-[18px]">{icon}</span>
  </button>
);

const ControlBtn = ({ icon, active, onClick, danger }: { icon: string; active: boolean; onClick: () => void; danger?: boolean }) => (
  <button onClick={onClick} className={`size-12 rounded-full flex items-center justify-center transition-all border ${active ? 'bg-white/5 border-white/10 text-white' : (danger ? 'bg-red-500/20 border-red-500/20 text-red-500' : 'bg-white/5 border-white/5 text-gray-500')} hover:scale-105 active:scale-90`}>
    <span className="material-symbols-outlined text-[20px]">{icon}</span>
  </button>
);

const ChatBox = ({ messages, onSend, userName, onUpload }: { messages: ChatMessage[]; onSend: (t: string) => void; userName: string; onUpload: (f: File) => void }) => {
  const [text, setText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages]);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setIsDragging(true);
    else if (e.type === 'dragleave') setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files[0]) onUpload(files[0]);
  };
  
  return (
    <div 
      className={`flex flex-col h-full relative transition-colors ${isDragging ? 'bg-primary/5' : ''}`}
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-20 backdrop-blur-sm pointer-events-none border-2 border-dashed border-primary m-4 rounded-2xl">
           <div className="text-center">
             <span className="material-symbols-outlined text-5xl text-primary animate-bounce">upload_file</span>
             <p className="text-xs font-black uppercase tracking-widest text-primary mt-2">释放以发送加密文件</p>
           </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col ${m.senderId === 'local' ? 'items-end' : 'items-start'}`}>
             <span className="text-[8px] font-black text-gray-600 mb-1 px-1 uppercase tracking-widest">{m.senderName}</span>
             <div className={`rounded-2xl max-w-[92%] overflow-hidden shadow-xl ${m.senderId === 'local' ? 'bg-primary text-white rounded-tr-none' : 'bg-white/5 border border-white/10 text-gray-300 rounded-tl-none'}`}>
               {m.type === 'text' && <p className="px-4 py-3 text-xs leading-relaxed break-words">{m.text}</p>}
               
               {/* 增强预览功能 */}
               {m.type === 'image' && (
                 <div className="relative group/media">
                    <img src={m.blobUrl} className="w-full h-auto cursor-zoom-in hover:brightness-110 transition-all" alt="E2EE content" onClick={() => window.open(m.blobUrl)} />
                 </div>
               )}
               
               {m.type === 'video' && (
                 <video src={m.blobUrl} controls className="w-full h-auto bg-black aspect-video outline-none" />
               )}
               
               {(m.type === 'image' || m.type === 'video' || m.type === 'file') && (
                 <div className="px-4 py-2 bg-black/40 flex items-center justify-between gap-4 border-t border-white/5">
                   <div className="flex items-center gap-2 overflow-hidden">
                     <span className="material-symbols-outlined text-[14px] text-gray-500 shrink-0">
                        {m.type === 'image' ? 'image' : m.type === 'video' ? 'movie' : 'description'}
                     </span>
                     <p className="text-[9px] font-mono truncate opacity-60 uppercase tracking-tighter">{m.fileName}</p>
                   </div>
                   <a href={m.blobUrl} download={m.fileName} className="size-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors group shrink-0">
                     <span className="material-symbols-outlined text-sm group-hover:text-accent">download</span>
                   </a>
                 </div>
               )}
             </div>
          </div>
        ))}
      </div>

      <div className="p-4 bg-black/60 border-t border-white/5 shrink-0 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }} className="relative flex gap-2">
          <label className="shrink-0 size-12 bg-white/5 border border-white/10 text-gray-400 rounded-xl flex items-center justify-center cursor-pointer hover:bg-white/10 transition-all active:scale-90">
              <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
              <span className="material-symbols-outlined">attach_file</span>
          </label>
          <input 
            className="flex-1 h-12 bg-white/5 border border-white/10 rounded-xl px-4 text-xs text-white focus:outline-none focus:border-primary/50 transition-all placeholder:text-gray-700" 
            placeholder="发送加密消息..." 
            value={text} 
            onChange={(e) => setText(e.target.value)} 
          />
          <button 
            type="submit" 
            disabled={!text.trim()} 
            className="shrink-0 size-12 bg-primary text-white rounded-xl flex items-center justify-center disabled:opacity-30 active:scale-95 transition-all shadow-lg"
          >
            <span className="material-symbols-outlined">send</span>
          </button>
        </form>
      </div>
    </div>
  );
};

export default Room;
