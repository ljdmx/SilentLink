
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RoomConfig, Participant, PrivacyFilter, ChatMessage, FileTransfer } from '../types';
import { deriveKey, encryptMessage, decryptMessage, encryptBuffer, decryptBuffer } from '../crypto';
import VideoCard from './VideoCard';

interface RoomProps {
  config: RoomConfig;
  onExit: () => void;
}

const Room: React.FC<RoomProps> = ({ config, onExit }) => {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<FileTransfer[]>([]);
  const [currentFilter, setCurrentFilter] = useState<PrivacyFilter>(config.defaultFilter);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  
  // Mesh 架构核心：管理多个 Peer
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const encryptionKeyRef = useRef<CryptoKey | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const addParticipant = useCallback((p: Participant) => {
    setParticipants(prev => {
      const exists = prev.find(u => u.id === p.id);
      if (exists) return prev.map(u => u.id === p.id ? { ...u, ...p } : u);
      return [...prev, p];
    });
  }, []);

  const removeParticipant = useCallback((id: string) => {
    setParticipants(prev => prev.filter(u => u.id !== id));
    peersRef.current.get(id)?.close();
    peersRef.current.delete(id);
    dataChannelsRef.current.delete(id);
  }, []);

  // 1. 初始化本地媒体和信令
  useEffect(() => {
    const init = async () => {
      encryptionKeyRef.current = await deriveKey(config.passphrase, config.roomId);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }, 
          audio: true 
        });
        localStreamRef.current = stream;
        addParticipant({ id: 'local', name: config.userName, isLocal: true, isHost: true, audioEnabled: true, videoEnabled: true, stream });
        
        connectSignaling();
      } catch (err) {
        alert("无法访问媒体设备，请检查权限。");
        console.error("Media init error:", err);
      }
    };

    const connectSignaling = () => {
      // 修复：显式判断协议，防止 blob: 等非标准协议导致 WebSocket 构造失败
      const isSecure = window.location.protocol === 'https:';
      const wsProtocol = isSecure ? 'wss:' : 'ws:';
      const host = window.location.host;

      // 如果无法获取 host（如在 blob 环境下），则无法建立信令
      if (!host || window.location.protocol === 'blob:') {
        console.warn("WebSocket signaling skipped: Host not available or using Blob URL. Signaling server is required for P2P.");
        setWsStatus('closed');
        return;
      }

      const wsUrl = `${wsProtocol}//${host}/ws`;
      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setWsStatus('open');
          ws.send(JSON.stringify({ type: 'join', roomId: config.roomId, name: config.userName }));
        };
        ws.onmessage = async (e) => handleSignalingMessage(JSON.parse(e.data));
        ws.onclose = () => {
          setWsStatus('closed');
          // 仅在 host 存在时尝试重连
          if (window.location.host && window.location.protocol !== 'blob:') {
            setTimeout(connectSignaling, 3000);
          }
        };
        ws.onerror = (err) => {
          console.error("WebSocket Error:", err);
          setWsStatus('closed');
        };
      } catch (e) {
        console.error("Failed to construct WebSocket:", e);
        setWsStatus('closed');
      }
    };

    init();
    return () => {
      wsRef.current?.close();
      peersRef.current.forEach(pc => pc.close());
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [config.roomId, config.userName, config.passphrase, addParticipant]);

  const handleSignalingMessage = async (msg: any) => {
    const { type, from, offer, answer, candidate, userId, name } = msg;

    switch (type) {
      case 'user-joined':
        setupPeerConnection(userId, name, true);
        break;
      
      case 'offer':
        await setupPeerConnection(from, "Peer", false);
        const pc = peersRef.current.get(from);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          wsRef.current?.send(JSON.stringify({ type: 'answer', to: from, answer: ans }));
        }
        break;

      case 'answer':
        await peersRef.current.get(from)?.setRemoteDescription(new RTCSessionDescription(answer));
        break;

      case 'ice-candidate':
        if (candidate) {
          await peersRef.current.get(from)?.addIceCandidate(new RTCIceCandidate(candidate));
        }
        break;

      case 'user-left':
        removeParticipant(userId);
        break;
    }
  };

  const setupPeerConnection = async (remoteId: string, remoteName: string, isOffer: boolean) => {
    if (peersRef.current.has(remoteId)) return;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    peersRef.current.set(remoteId, pc);

    localStreamRef.current?.getTracks().forEach(track => {
      pc.addTrack(track, localStreamRef.current!);
    });

    pc.ontrack = (e) => {
      addParticipant({ id: remoteId, name: remoteName, isLocal: false, isHost: false, audioEnabled: true, videoEnabled: true, stream: e.streams[0] });
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsRef.current?.send(JSON.stringify({ type: 'ice-candidate', to: remoteId, candidate: e.candidate }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        removeParticipant(remoteId);
      }
    };

    if (isOffer) {
      const dc = pc.createDataChannel('secure-transfer', { ordered: true });
      setupDataChannel(remoteId, dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsRef.current?.send(JSON.stringify({ type: 'offer', to: remoteId, offer }));
    } else {
      pc.ondatachannel = (e) => setupDataChannel(remoteId, e.channel);
    }
  };

  const setupDataChannel = (remoteId: string, dc: RTCDataChannel) => {
    dataChannelsRef.current.set(remoteId, dc);
    dc.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        const payload = JSON.parse(e.data);
        if (payload.type === 'chat') {
          const text = await decryptMessage(encryptionKeyRef.current!, payload.data, payload.iv);
          setMessages(prev => [...prev, { id: Date.now().toString(), senderId: remoteId, senderName: 'Peer', text, timestamp: Date.now() }]);
        } else if (payload.type === 'file-meta') handleFileMetaReceive(payload);
      } else handleFileChunkReceive(e.data);
    };
  };

  const sendMessage = async (text: string) => {
    const encrypted = await encryptMessage(encryptionKeyRef.current!, text);
    const payload = JSON.stringify({ type: 'chat', ...encrypted });
    
    let sent = false;
    dataChannelsRef.current.forEach(dc => {
      if (dc.readyState === 'open') {
        dc.send(payload);
        sent = true;
      }
    });

    if (sent) {
      setMessages(prev => [...prev, { id: Date.now().toString(), senderId: 'local', senderName: config.userName, text, timestamp: Date.now() }]);
    }
  };

  const handleFileUpload = async (file: File) => {
    const fileId = Math.random().toString(36).substring(7);
    setFiles(prev => [{ id: fileId, name: file.name, size: file.size, progress: 0, status: 'transferring' }, ...prev]);
    
    const meta = JSON.stringify({ type: 'file-meta', id: fileId, name: file.name, size: file.size });
    dataChannelsRef.current.forEach(dc => dc.readyState === 'open' && dc.send(meta));

    const reader = file.stream().getReader();
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const { data, iv } = await encryptBuffer(encryptionKeyRef.current!, value.buffer);
      const packet = new Uint8Array(iv.length + data.byteLength);
      packet.set(iv, 0); packet.set(new Uint8Array(data), iv.length);
      
      dataChannelsRef.current.forEach(dc => {
        if (dc.readyState === 'open') dc.send(packet);
      });

      offset += value.byteLength;
      setFiles(prev => prev.map(f => f.id === fileId ? { ...f, progress: Math.round((offset / file.size) * 100) } : f));
    }
    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'completed' } : f));
  };

  const receivingFileRef = useRef<{ id: string; name: string; size: number; received: number; chunks: ArrayBuffer[] } | null>(null);
  const handleFileMetaReceive = (meta: any) => {
    receivingFileRef.current = { ...meta, received: 0, chunks: [] };
    setFiles(prev => [{ id: meta.id, name: meta.name, size: meta.size, progress: 0, status: 'transferring' }, ...prev]);
  };

  const handleFileChunkReceive = async (data: ArrayBuffer) => {
    const state = receivingFileRef.current; if (!state) return;
    const iv = new Uint8Array(data.slice(0, 12));
    const encryptedData = data.slice(12);
    const decryptedChunk = await decryptBuffer(encryptionKeyRef.current!, encryptedData, iv);
    state.chunks.push(decryptedChunk); state.received += decryptedChunk.byteLength;
    const progress = Math.round((state.received / state.size) * 100);
    setFiles(prev => prev.map(f => f.id === state.id ? { ...f, progress } : f));
    if (state.received >= state.size) {
      const url = URL.createObjectURL(new Blob(state.chunks));
      const a = document.createElement('a'); a.href = url; a.download = state.name; a.click();
      setFiles(prev => prev.map(f => f.id === state.id ? { ...f, status: 'completed' } : f));
      receivingFileRef.current = null;
    }
  };

  const toggleMute = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setIsMuted(!track.enabled); }
  };

  const toggleVideo = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setIsVideoOff(!track.enabled); }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden relative">
      <div className="absolute top-0 left-1/4 size-[500px] bg-primary/5 blur-[120px] rounded-full pointer-events-none"></div>

      <header className="h-12 lg:h-14 shrink-0 flex items-center justify-between px-4 lg:px-6 glass z-[60] border-b-0 m-2 rounded-xl lg:rounded-2xl">
        <div className="flex items-center gap-3 lg:gap-4 overflow-hidden">
          <div className="size-7 lg:size-8 bg-primary/10 rounded-lg flex items-center justify-center border border-primary/20 shrink-0">
            <span className="material-symbols-outlined text-primary text-sm lg:text-lg fill-1">verified_user</span>
          </div>
          <div className="overflow-hidden">
            <h2 className="text-[9px] lg:text-[10px] font-black tracking-[0.2em] text-gray-500 uppercase truncate">ID: {config.roomId}</h2>
            <div className="flex items-center gap-1.5">
               <span className={`size-1 rounded-full ${wsStatus === 'open' ? 'bg-accent animate-pulse' : 'bg-red-500 animate-ping'}`}></span>
               <span className="text-[8px] lg:text-[9px] font-bold text-accent uppercase tracking-widest whitespace-nowrap">
                 {wsStatus === 'open' ? 'Encrypted Channel' : 'Signaling Offline'}
               </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
            <button onClick={() => { navigator.clipboard.writeText(config.roomId); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000); }} 
                    className="h-7 lg:h-8 px-2 lg:px-3 rounded-lg bg-white/5 hover:bg-white/10 transition-all border border-white/5 text-[9px] lg:text-[10px] font-bold uppercase tracking-widest flex items-center gap-2">
                <span className="material-symbols-outlined text-xs lg:text-sm">{isCopied ? 'check' : 'share'}</span>
                <span className="hidden sm:inline">{isCopied ? '已复制 ID' : '邀请加入'}</span>
            </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden relative p-2 pt-0 pb-28 lg:pb-2">
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
          {participants.length < 2 ? (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-6 lg:space-y-8 animate-in fade-in zoom-in duration-700">
                <div className="relative">
                    <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full scale-150"></div>
                    <div className="size-24 lg:size-32 rounded-full glass flex items-center justify-center relative border-primary/20 border-2">
                        <span className="material-symbols-outlined text-4xl lg:text-5xl text-primary animate-float">sensors</span>
                    </div>
                </div>
                <div className="space-y-3 px-6">
                    <h3 className="text-xl lg:text-2xl font-black tracking-tight text-white">等待对端加密节点...</h3>
                    <p className="text-gray-500 text-xs lg:text-sm max-w-xs mx-auto font-medium leading-relaxed">
                      信令服务器已连接。请确保对方输入了相同的房间 ID 和口令。
                    </p>
                    {wsStatus !== 'open' && (
                      <p className="text-red-400 text-[10px] font-black uppercase bg-red-400/10 px-4 py-2 rounded-lg border border-red-400/20">
                        信令连接异常：请检查 WebSocket 地址
                      </p>
                    )}
                </div>
            </div>
          ) : (
            <div className={`grid gap-3 lg:gap-4 h-full content-start justify-center ${participants.length === 1 ? 'grid-cols-1' : participants.length === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-2 lg:grid-cols-3'}`}>
              {participants.map(p => (
                <VideoCard key={p.id} participant={p} filter={p.isLocal ? currentFilter : PrivacyFilter.NONE} />
              ))}
            </div>
          )}
        </div>

        <div className={`fixed inset-0 lg:static lg:inset-auto lg:w-96 glass lg:bg-transparent lg:backdrop-blur-none lg:border-l-0 transform transition-all duration-300 ease-in-out z-[110] flex flex-col lg:m-2 lg:rounded-2xl overflow-hidden ${isChatOpen ? 'translate-y-0 opacity-100' : 'translate-y-full lg:hidden opacity-0 scale-95 pointer-events-none'}`}>
             <div className="h-14 flex items-center justify-between px-6 border-b border-white/5 bg-black/40 lg:bg-white/2px shrink-0">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                    E2EE 安全会话通道
                </h3>
                <button onClick={() => setIsChatOpen(false)} className="size-8 rounded-full hover:bg-white/5 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-lg">close</span>
                </button>
             </div>
             <div className="flex-1 overflow-hidden bg-background lg:bg-transparent flex flex-col">
                <ChatBox 
                    messages={messages} 
                    onSend={sendMessage} 
                    userName={config.userName} 
                    files={files} 
                    onUpload={handleFileUpload} 
                />
             </div>
        </div>
      </main>

      <div className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] lg:bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2 lg:gap-3 p-2 lg:p-3 glass rounded-3xl lg:rounded-[2rem] z-[100] shadow-2xl shadow-black transition-all ${isChatOpen ? 'translate-y-24 opacity-0 scale-90 pointer-events-none' : 'translate-y-0 opacity-100'}`}>
        <div className="flex items-center gap-1 bg-white/5 p-1 rounded-2xl mr-1 lg:mr-2">
            <FilterBtn active={currentFilter === PrivacyFilter.NONE} icon="visibility" onClick={() => setCurrentFilter(PrivacyFilter.NONE)} />
            <FilterBtn active={currentFilter === PrivacyFilter.MOSAIC} icon="grid_view" onClick={() => setCurrentFilter(PrivacyFilter.MOSAIC)} />
            <FilterBtn active={currentFilter === PrivacyFilter.BLACK} icon="videocam_off" onClick={() => setCurrentFilter(PrivacyFilter.BLACK)} />
        </div>

        <ControlBtn icon={isMuted ? 'mic_off' : 'mic'} active={!isMuted} onClick={toggleMute} danger={isMuted} />
        <ControlBtn icon={isVideoOff ? 'videocam_off' : 'videocam'} active={!isVideoOff} onClick={toggleVideo} danger={isVideoOff} />
        
        <div className="w-px h-6 bg-white/10 mx-1"></div>
        <ControlBtn icon="forum" active={isChatOpen} onClick={() => setIsChatOpen(true)} />
        <div className="w-px h-6 bg-white/10 mx-1"></div>

        <button onClick={onExit} className="size-10 lg:size-12 rounded-full bg-red-500 hover:bg-red-400 text-white flex items-center justify-center transition-all active:scale-90 shadow-lg shadow-red-500/20">
            <span className="material-symbols-outlined fill-1 text-sm lg:text-base">call_end</span>
        </button>
      </div>
    </div>
  );
};

const FilterBtn = ({ active, icon, onClick }: { active: boolean; icon: string; onClick: () => void }) => (
  <button onClick={onClick} className={`size-7 lg:size-8 rounded-lg flex items-center justify-center transition-all ${active ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'text-gray-500 hover:text-white hover:bg-white/5'}`}>
    <span className="material-symbols-outlined text-sm lg:text-[18px]">{icon}</span>
  </button>
);

const ControlBtn = ({ icon, active, onClick, danger }: { icon: string; active: boolean; onClick: () => void; danger?: boolean }) => (
  <button onClick={onClick} className={`size-10 lg:size-12 rounded-full flex items-center justify-center transition-all border ${active ? 'bg-white/5 border-white/10 text-white' : (danger ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-white/5 border-white/5 text-gray-500')} hover:scale-105 active:scale-90`}>
    <span className="material-symbols-outlined text-sm lg:text-[20px]">{icon}</span>
  </button>
);

const ChatBox = ({ messages, onSend, userName, files, onUpload }: { messages: ChatMessage[]; onSend: (t: string) => void; userName: string; files: FileTransfer[]; onUpload: (f: File) => void }) => {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, files]);

  return (
    <div className="flex flex-col h-full bg-background lg:bg-transparent">
      {files.length > 0 && (
        <div className="shrink-0 max-h-48 overflow-y-auto p-4 border-b border-white/5 bg-white/[0.02] custom-scrollbar">
            <div className="flex items-center justify-between mb-3 px-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-primary">传输链路活跃</span>
                <span className="text-[8px] font-bold text-gray-600 uppercase">{files.length} 对象</span>
            </div>
            <div className="space-y-2">
                {files.map(f => (
                    <div key={f.id} className="p-2.5 rounded-xl bg-black/40 border border-white/5 flex flex-col gap-2">
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2 overflow-hidden">
                                <span className="material-symbols-outlined text-sm text-gray-500">attach_file</span>
                                <p className="text-[10px] font-bold truncate text-gray-300">{f.name}</p>
                            </div>
                            <span className="text-[8px] font-black text-primary uppercase shrink-0">{f.status === 'completed' ? '成功' : `${f.progress}%`}</span>
                        </div>
                        <div className="h-0.5 w-full bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${f.progress}%` }}></div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 lg:space-y-6 custom-scrollbar">
        {messages.length === 0 && files.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center opacity-10 text-center py-20">
                <span className="material-symbols-outlined text-6xl mb-4">encrypted</span>
                <p className="text-[10px] font-black uppercase tracking-[0.3em]">端到端加密已就绪</p>
            </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col ${m.senderId === 'local' ? 'items-end' : 'items-start'}`}>
             <div className={`px-4 py-2.5 lg:py-3 rounded-2xl max-w-[85%] text-xs lg:text-sm leading-relaxed ${m.senderId === 'local' ? 'bg-primary text-white rounded-tr-none' : 'bg-white/5 border border-white/10 text-gray-300 rounded-tl-none'}`}>
               {m.text}
             </div>
             <span className="text-[8px] font-bold text-gray-700 mt-1.5 mx-1 uppercase tracking-widest">{new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
          </div>
        ))}
      </div>

      <div className="p-4 bg-black/80 lg:bg-white/2px border-t border-white/5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] lg:pb-4 shrink-0">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }} className="relative flex gap-2">
          <label className="shrink-0 size-11 lg:size-12 bg-white/5 border border-white/10 text-gray-400 rounded-xl flex items-center justify-center hover:bg-white/10 hover:text-white transition-all cursor-pointer">
              <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
              <span className="material-symbols-outlined text-sm lg:text-[20px]">add_circle</span>
          </label>
          
          <input 
            className="flex-1 h-11 lg:h-12 bg-white/5 border border-white/10 rounded-xl px-4 text-xs lg:text-sm focus:border-primary/50 outline-none transition-all placeholder:text-gray-700 text-white" 
            placeholder="发送加密消息..." 
            value={text} 
            onChange={(e) => setText(e.target.value)} 
          />
          <button type="submit" className="shrink-0 size-11 lg:size-12 bg-primary text-white rounded-xl flex items-center justify-center hover:bg-blue-600 transition-all active:scale-90 shadow-lg shadow-primary/20">
            <span className="material-symbols-outlined text-sm lg:text-[18px]">send</span>
          </button>
        </form>
      </div>
    </div>
  );
};

export default Room;
