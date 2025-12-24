
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RoomConfig, Participant, PrivacyFilter, ChatMessage, FileTransfer } from '../types';
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
  
  // 核心连接状态
  const [role, setRole] = useState<HandshakeRole>('none');
  const [localSDP, setLocalSDP] = useState('');
  const [remoteSDPInput, setRemoteSDPInput] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'preparing' | 'ready' | 'connected'>('idle');

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
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
    const pc = peersRef.current.get(id);
    if (pc) {
      pc.close();
      peersRef.current.delete(id);
    }
    dataChannelsRef.current.delete(id);
  }, []);

  // 初始化媒体与密钥
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
      } catch (err) {
        console.error("Media access error:", err);
      }
    };
    init();
    return () => {
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
      dataChannelsRef.current.clear();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [config.roomId, config.userName, config.passphrase, addParticipant]);

  const setupPeerConnection = async (remoteId: string, isOffer: boolean): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    peersRef.current.set(remoteId, pc);
    localStreamRef.current?.getTracks().forEach(track => {
      if (localStreamRef.current) pc.addTrack(track, localStreamRef.current);
    });

    pc.ontrack = (e) => {
      addParticipant({ id: remoteId, name: "远端成员", isLocal: false, isHost: false, audioEnabled: true, videoEnabled: true, stream: e.streams[0] });
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setConnectionStatus('connected');
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            removeParticipant(remoteId);
            if (peersRef.current.size === 0) {
                setConnectionStatus('idle');
                setRole('none');
                setLocalSDP('');
                setRemoteSDPInput('');
            }
        }
    };

    if (isOffer) {
      const dc = pc.createDataChannel('secure-tunnel', { ordered: true });
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
            setMessages(prev => [...prev, { id: Date.now().toString(), senderId: remoteId, senderName: 'Peer', text, timestamp: Date.now() }]);
          } else if (payload.type === 'file-meta') handleFileMetaReceive(payload);
        } catch (err) { console.error("Data processing error:", err); }
      } else handleFileChunkReceive(e.data);
    };
  };

  // ---------------- 握手逻辑流 ----------------

  // 发起方：生成 Offer
  const startAsInitiator = async () => {
    setRole('initiator');
    setConnectionStatus('preparing');
    const pc = await setupPeerConnection('peer', true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
        setConnectionStatus('ready');
      }
    };
    if (pc.iceGatheringState === 'complete') {
        setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
        setConnectionStatus('ready');
    }
  };

  // 发起方：完成最后一步 (回填 Answer)
  const finalizeAsInitiator = async () => {
    if (!remoteSDPInput) return;
    try {
      const decoded = JSON.parse(atob(remoteSDPInput));
      const pc = peersRef.current.get('peer');
      if (pc && decoded.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(decoded));
        // 连接状态将通过 onconnectionstatechange 自动更新
      } else {
        alert("无效的代码。发起方需要粘贴接收方发回的 Answer。");
      }
    } catch (e) {
      alert("代码解析失败，请确保复制完整。");
    }
  };

  // 接收方：处理 Offer 并生成 Answer
  const handleOfferAndReply = async () => {
    if (!remoteSDPInput) return;
    try {
      const decoded = JSON.parse(atob(remoteSDPInput));
      if (decoded.type !== 'offer') {
        alert("代码类型错误。接收方必须粘贴发起方的 Offer。");
        return;
      }
      setRole('receiver');
      setConnectionStatus('preparing');
      const pc = await setupPeerConnection('peer', false);
      await pc.setRemoteDescription(new RTCSessionDescription(decoded));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
          setConnectionStatus('ready');
        }
      };
      if (pc.iceGatheringState === 'complete') {
        setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
        setConnectionStatus('ready');
      }
    } catch (e) {
      alert("解析失败，请检查 Offer 代码完整性。");
    }
  };

  const sendMessage = async (text: string) => {
    if (!encryptionKeyRef.current) return;
    const encrypted = await encryptMessage(encryptionKeyRef.current, text);
    const payload = JSON.stringify({ type: 'chat', ...encrypted });
    let sent = false;
    dataChannelsRef.current.forEach(dc => {
      if (dc && dc.readyState === 'open') { dc.send(payload); sent = true; }
    });
    if (sent) setMessages(prev => [...prev, { id: Date.now().toString(), senderId: 'local', senderName: config.userName, text, timestamp: Date.now() }]);
  };

  const handleFileUpload = async (file: File) => {
    if (!encryptionKeyRef.current) return;
    const fileId = Math.random().toString(36).substring(7);
    setFiles(prev => [{ id: fileId, name: file.name, size: file.size, progress: 0, status: 'transferring' }, ...prev]);
    const meta = JSON.stringify({ type: 'file-meta', id: fileId, name: file.name, size: file.size });
    dataChannelsRef.current.forEach(dc => { if (dc && dc.readyState === 'open') dc.send(meta); });
    const reader = file.stream().getReader();
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const { data, iv } = await encryptBuffer(encryptionKeyRef.current, value.buffer);
      const packet = new Uint8Array(iv.length + data.byteLength);
      packet.set(iv, 0); packet.set(new Uint8Array(data), iv.length);
      dataChannelsRef.current.forEach(dc => { if (dc && dc.readyState === 'open') dc.send(packet); });
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
    const state = receivingFileRef.current; if (!state || !encryptionKeyRef.current) return;
    try {
      const iv = new Uint8Array(data.slice(0, 12));
      const encryptedData = data.slice(12);
      const decryptedChunk = await decryptBuffer(encryptionKeyRef.current, encryptedData, iv);
      state.chunks.push(decryptedChunk); state.received += decryptedChunk.byteLength;
      const progress = Math.round((state.received / state.size) * 100);
      setFiles(prev => prev.map(f => f.id === state.id ? { ...f, progress } : f));
      if (state.received >= state.size) {
        const url = URL.createObjectURL(new Blob(state.chunks));
        const a = document.createElement('a'); a.href = url; a.download = state.name; a.click();
        setFiles(prev => prev.map(f => f.id === state.id ? { ...f, status: 'completed' } : f));
        receivingFileRef.current = null;
      }
    } catch (e) { console.error("File decryption error:", e); }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden relative">
      <header className="h-12 lg:h-14 shrink-0 flex items-center justify-between px-4 lg:px-6 glass z-[60] m-2 rounded-xl lg:rounded-2xl border-none">
        <div className="flex items-center gap-3">
          <div className="size-8 bg-primary/10 rounded-lg flex items-center justify-center border border-primary/20">
            <span className="material-symbols-outlined text-primary text-sm fill-1">verified_user</span>
          </div>
          <div>
            <h2 className="text-[10px] font-black tracking-widest text-gray-500 uppercase">SERVERLESS P2P PROTOCOL</h2>
            <div className="flex items-center gap-1.5">
               <span className={`size-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-accent shadow-[0_0_8px_#22c55e]' : 'bg-yellow-500 animate-pulse'}`}></span>
               <span className="text-[9px] font-bold text-white uppercase tracking-wider">{connectionStatus.toUpperCase()}</span>
            </div>
          </div>
        </div>
        <button onClick={onExit} className="h-8 px-4 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[10px] font-black uppercase tracking-widest transition-all">物理断开</button>
      </header>

      <main className="flex-1 flex overflow-hidden relative p-2 pt-0">
        <div className="flex-1 flex flex-col relative overflow-hidden">
          {connectionStatus !== 'connected' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-12 space-y-12 animate-in fade-in duration-700 overflow-y-auto custom-scrollbar">
                
                {role === 'none' ? (
                    <div className="text-center space-y-12 max-w-2xl animate-in zoom-in-95">
                        <div className="space-y-4">
                            <h3 className="text-3xl lg:text-5xl font-black text-white tracking-tighter uppercase leading-tight">请选择您的物理角色</h3>
                            <p className="text-gray-500 text-sm font-medium leading-relaxed max-w-lg mx-auto">
                              P2P 链路建立需要双方各司其职。请与对端沟通并在此选择您的操作入口。
                            </p>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-3xl">
                            <button 
                                onClick={startAsInitiator}
                                className="group relative flex flex-col items-center justify-center gap-6 p-10 lg:p-14 glass rounded-[3rem] border-primary/10 hover:border-primary/40 hover:bg-primary/5 transition-all active:scale-95 shadow-xl"
                            >
                                <div className="size-20 rounded-3xl bg-primary/10 flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
                                    <span className="material-symbols-outlined text-5xl">rocket_launch</span>
                                </div>
                                <div className="text-center">
                                    <h4 className="text-xl font-black text-white uppercase tracking-widest mb-2">我是发起方</h4>
                                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">INITIATOR / 生成代码</p>
                                </div>
                            </button>

                            <button 
                                onClick={() => setRole('receiver')}
                                className="group relative flex flex-col items-center justify-center gap-6 p-10 lg:p-14 glass rounded-[3rem] border-accent/10 hover:border-accent/40 hover:bg-accent/5 transition-all active:scale-95 shadow-xl"
                            >
                                <div className="size-20 rounded-3xl bg-accent/10 flex items-center justify-center text-accent group-hover:scale-110 transition-transform">
                                    <span className="material-symbols-outlined text-5xl">join_inner</span>
                                </div>
                                <div className="text-center">
                                    <h4 className="text-xl font-black text-white uppercase tracking-widest mb-2">我是接收方</h4>
                                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">RECEIVER / 等待代码</p>
                                </div>
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-4xl animate-in slide-in-from-bottom-10 duration-500">
                        {/* 手动交换终端 */}
                        <div className={`glass rounded-[3rem] p-8 lg:p-12 shadow-3xl bg-black/40 relative overflow-hidden flex flex-col gap-10 border-t-4 transition-all ${role === 'initiator' ? 'border-t-primary' : 'border-t-accent'}`}>
                            
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                                <div className="flex items-center gap-4">
                                    <button onClick={() => {setRole('none'); setLocalSDP(''); setRemoteSDPInput('');}} className="size-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                                        <span className="material-symbols-outlined text-gray-400">arrow_back</span>
                                    </button>
                                    <div>
                                        <h3 className="text-2xl font-black text-white tracking-tight uppercase">
                                            {role === 'initiator' ? '发起方握手控制台' : '接收方握手控制台'}
                                        </h3>
                                        <p className="text-[9px] font-black text-gray-500 uppercase tracking-[0.3em]">
                                            {role === 'initiator' ? 'OFFER & CALLBACK SYNC' : 'INBOUND OFFER PARSING'}
                                        </p>
                                    </div>
                                </div>
                                <div className="px-4 py-1.5 bg-white/5 border border-white/10 rounded-full flex items-center gap-2">
                                    <span className="size-2 rounded-full bg-yellow-500 animate-pulse"></span>
                                    <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest">链路连接中...</span>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                                {/* 步骤 01 */}
                                <div className="flex flex-col gap-6">
                                    <div className="flex items-center gap-3">
                                        <span className={`size-8 rounded-2xl flex items-center justify-center text-[11px] font-black border ${role === 'initiator' ? 'bg-primary/20 text-primary border-primary/30' : 'bg-white/5 text-gray-500 border-white/10'}`}>01</span>
                                        <h4 className="text-xs font-black uppercase text-white tracking-widest">
                                            {role === 'initiator' ? '发送您的握手包' : '粘贴对方的代码'}
                                        </h4>
                                    </div>

                                    {role === 'initiator' ? (
                                        <div className="flex-1 flex flex-col gap-3">
                                            <div className="relative group flex-1 min-h-[160px]">
                                                <textarea 
                                                    readOnly 
                                                    value={localSDP || '正在生成加密 Offer...'} 
                                                    className="w-full h-full bg-black/60 border border-primary/20 rounded-2xl p-4 text-[9px] font-mono text-primary outline-none resize-none custom-scrollbar" 
                                                />
                                                <div className="absolute top-2 right-2 px-2 py-0.5 bg-primary/20 border border-primary/30 rounded text-[8px] font-black text-primary uppercase tracking-tighter">OFFER PKG</div>
                                            </div>
                                            <button 
                                                onClick={() => {navigator.clipboard.writeText(localSDP); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}}
                                                className="w-full h-12 bg-primary text-white rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all shadow-lg shadow-primary/20"
                                            >
                                                <span className="material-symbols-outlined text-sm">{isCopied ? 'check' : 'content_copy'}</span>
                                                {isCopied ? '已复制' : '复制 Offer 代码'}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex-1 flex flex-col gap-3">
                                            <textarea 
                                                placeholder="在此粘贴发起方的代码 (Offer)..."
                                                value={remoteSDPInput}
                                                onChange={(e) => setRemoteSDPInput(e.target.value)}
                                                className="flex-1 min-h-[160px] bg-black/60 border border-white/10 rounded-2xl p-4 text-[9px] font-mono text-accent outline-none focus:border-accent/40 resize-none transition-all placeholder:text-gray-700"
                                            />
                                            <button 
                                                onClick={handleOfferAndReply}
                                                disabled={!remoteSDPInput || connectionStatus === 'preparing'}
                                                className="w-full h-12 bg-white/5 border border-white/10 hover:bg-white/10 text-white rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 disabled:opacity-20 transition-all"
                                            >
                                                <span className="material-symbols-outlined text-sm text-accent">bolt</span>
                                                解析代码并回应
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {/* 步骤 02 */}
                                <div className="flex flex-col gap-6">
                                    <div className="flex items-center gap-3">
                                        <span className={`size-8 rounded-2xl flex items-center justify-center text-[11px] font-black border ${role === 'receiver' || (role === 'initiator' && remoteSDPInput) ? 'bg-accent/20 text-accent border-accent/30' : 'bg-white/5 text-gray-500 border-white/10'}`}>02</span>
                                        <h4 className="text-xs font-black uppercase text-white tracking-widest">
                                            {role === 'initiator' ? '粘贴回执建立连接' : '回传您的回应包'}
                                        </h4>
                                    </div>

                                    {role === 'initiator' ? (
                                        <div className="flex-1 flex flex-col gap-3">
                                            <textarea 
                                                placeholder="粘贴接收方发回的代码 (Answer)..."
                                                value={remoteSDPInput}
                                                onChange={(e) => setRemoteSDPInput(e.target.value)}
                                                className="flex-1 min-h-[160px] bg-black/60 border border-white/10 rounded-2xl p-4 text-[9px] font-mono text-accent outline-none focus:border-accent/40 resize-none transition-all"
                                            />
                                            <button 
                                                onClick={finalizeAsInitiator}
                                                disabled={!remoteSDPInput}
                                                className="w-full h-12 bg-accent text-black rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 disabled:opacity-20 transition-all shadow-lg shadow-accent/20"
                                            >
                                                <span className="material-symbols-outlined text-sm">handshake</span>
                                                激活安全隧道
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex-1 flex flex-col gap-3">
                                            <div className="relative group flex-1 min-h-[160px]">
                                                <textarea 
                                                    readOnly 
                                                    value={localSDP || '等待步骤 01 解析...'} 
                                                    className="w-full h-full bg-black/60 border border-accent/20 rounded-2xl p-4 text-[9px] font-mono text-accent outline-none resize-none custom-scrollbar" 
                                                />
                                                <div className="absolute top-2 right-2 px-2 py-0.5 bg-accent/20 border border-accent/30 rounded text-[8px] font-black text-accent uppercase tracking-tighter">ANSWER PKG</div>
                                            </div>
                                            <button 
                                                onClick={() => {navigator.clipboard.writeText(localSDP); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}}
                                                disabled={!localSDP}
                                                className="w-full h-12 bg-accent text-black rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-20 shadow-lg shadow-accent/20"
                                            >
                                                <span className="material-symbols-outlined text-sm">{isCopied ? 'check' : 'content_copy'}</span>
                                                {isCopied ? '已复制' : '复制 Answer 代码'}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                            
                            <div className="pt-8 border-t border-white/5 opacity-50 flex flex-col md:flex-row items-center justify-between gap-4">
                                <div className="flex items-center gap-8">
                                    <div className="space-y-0.5">
                                        <p className="text-[7px] font-black text-white uppercase tracking-widest">物理特征</p>
                                        <p className="text-[8px] font-mono text-gray-500 uppercase">SERVERLESS-ISOLATION-V1</p>
                                    </div>
                                    <div className="h-6 w-px bg-white/10 hidden md:block"></div>
                                    <div className="space-y-0.5">
                                        <p className="text-[7px] font-black text-white uppercase tracking-widest">当前会话</p>
                                        <p className="text-[8px] font-mono text-gray-500 truncate max-w-[120px]">{config.roomId}</p>
                                    </div>
                                </div>
                                <p className="text-[8px] font-bold text-gray-600 uppercase tracking-[0.3em]">物理隔离链路协商 v1.2</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
          ) : (
            <div className="flex-1 p-2 grid gap-4 h-full content-start justify-center md:grid-cols-2 lg:grid-cols-2">
              {participants.map(p => (
                <VideoCard key={p.id} participant={p} filter={p.isLocal ? currentFilter : PrivacyFilter.NONE} />
              ))}
            </div>
          )}
        </div>

        {/* 侧边聊天面板 */}
        <div className={`fixed inset-0 lg:static lg:inset-auto lg:w-96 glass transform transition-all duration-300 z-[110] flex flex-col lg:m-2 lg:rounded-2xl overflow-hidden ${isChatOpen ? 'translate-y-0 opacity-100 shadow-[0_0_100px_rgba(0,0,0,0.8)]' : 'translate-y-full lg:hidden opacity-0 scale-95 pointer-events-none'}`}>
             <div className="h-14 flex items-center justify-between px-6 border-b border-white/5 bg-black/40 shrink-0">
                <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-accent"></span>
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">E2EE 数据隧道</h3>
                </div>
                <button onClick={() => setIsChatOpen(false)} className="size-8 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-lg text-gray-500">close</span>
                </button>
             </div>
             <div className="flex-1 overflow-hidden bg-background flex flex-col">
                <ChatBox messages={messages} onSend={sendMessage} userName={config.userName} files={files} onUpload={handleFileUpload} />
             </div>
        </div>
      </main>

      {/* 底部控制面板 */}
      {connectionStatus === 'connected' && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3 p-3 glass rounded-[2rem] z-[100] shadow-2xl shadow-black animate-in slide-in-from-bottom-10">
          <div className="flex items-center gap-1 bg-white/5 p-1 rounded-2xl mr-2">
              <FilterBtn active={currentFilter === PrivacyFilter.NONE} icon="visibility" onClick={() => setCurrentFilter(PrivacyFilter.NONE)} />
              <FilterBtn active={currentFilter === PrivacyFilter.MOSAIC} icon="grid_view" onClick={() => setCurrentFilter(PrivacyFilter.MOSAIC)} />
              <FilterBtn active={currentFilter === PrivacyFilter.BLACK} icon="videocam_off" onClick={() => setCurrentFilter(PrivacyFilter.BLACK)} />
          </div>
          <ControlBtn icon={isMuted ? 'mic_off' : 'mic'} active={!isMuted} onClick={() => { const t = localStreamRef.current?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; setIsMuted(!t.enabled); } }} danger={isMuted} />
          <ControlBtn icon={isVideoOff ? 'videocam_off' : 'videocam'} active={!isVideoOff} onClick={() => { const t = localStreamRef.current?.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; setIsVideoOff(!t.enabled); } }} danger={isVideoOff} />
          <div className="w-px h-6 bg-white/10 mx-1"></div>
          <ControlBtn icon="forum" active={isChatOpen} onClick={() => setIsChatOpen(true)} />
        </div>
      )}
    </div>
  );
};

const FilterBtn = ({ active, icon, onClick }: { active: boolean; icon: string; onClick: () => void }) => (
  <button onClick={onClick} className={`size-8 rounded-lg flex items-center justify-center transition-all ${active ? 'bg-primary text-white shadow-lg shadow-primary/30' : 'text-gray-500 hover:text-white hover:bg-white/10'}`}>
    <span className="material-symbols-outlined text-[18px]">{icon}</span>
  </button>
);

const ControlBtn = ({ icon, active, onClick, danger }: { icon: string; active: boolean; onClick: () => void; danger?: boolean }) => (
  <button onClick={onClick} className={`size-12 rounded-full flex items-center justify-center transition-all border ${active ? 'bg-white/5 border-white/10 text-white' : (danger ? 'bg-red-500/20 border-red-500/20 text-red-500' : 'bg-white/5 border-white/5 text-gray-500')} hover:scale-105 active:scale-90`}>
    <span className="material-symbols-outlined text-[20px]">{icon}</span>
  </button>
);

const ChatBox = ({ messages, onSend, userName, files, onUpload }: { messages: ChatMessage[]; onSend: (t: string) => void; userName: string; files: FileTransfer[]; onUpload: (f: File) => void }) => {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, files]);
  return (
    <div className="flex flex-col h-full">
      {files.length > 0 && (
        <div className="shrink-0 max-h-48 overflow-y-auto p-4 border-b border-white/5 bg-white/[0.02] custom-scrollbar">
            <div className="space-y-2">
                {files.map(f => (
                    <div key={f.id} className="p-3 rounded-2xl bg-black/40 border border-white/5 flex flex-col gap-2">
                        <div className="flex justify-between items-center">
                            <p className="text-[10px] font-black truncate text-gray-300 uppercase tracking-tight">{f.name}</p>
                            <span className="text-[8px] font-black text-primary uppercase">{f.status === 'completed' ? '成功' : `${f.progress}%`}</span>
                        </div>
                        <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${f.progress}%` }}></div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col ${m.senderId === 'local' ? 'items-end' : 'items-start'}`}>
             <div className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-xs leading-relaxed ${m.senderId === 'local' ? 'bg-primary text-white rounded-tr-none' : 'bg-white/5 border border-white/10 text-gray-300 rounded-tl-none'}`}>
               {m.text}
             </div>
             <span className="text-[8px] font-bold text-gray-700 mt-2 mx-1 uppercase tracking-widest">{new Date(m.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
          </div>
        ))}
      </div>
      <div className="p-4 bg-black/80 border-t border-white/5 shrink-0 pb-[calc(1.5rem+env(safe-area-inset-bottom))] lg:pb-4">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }} className="relative flex gap-2">
          <label className="shrink-0 size-12 bg-white/5 border border-white/10 text-gray-400 rounded-xl flex items-center justify-center cursor-pointer hover:bg-white/10 transition-colors">
              <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
              <span className="material-symbols-outlined">attach_file</span>
          </label>
          <input className="flex-1 h-12 bg-white/5 border border-white/10 rounded-xl px-4 text-sm text-white focus:outline-none focus:border-primary/50 transition-all" placeholder="加密消息..." value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" disabled={!text.trim()} className="shrink-0 size-12 bg-primary text-white rounded-xl flex items-center justify-center disabled:opacity-30 transition-all shadow-lg shadow-primary/20"><span className="material-symbols-outlined">send</span></button>
        </form>
      </div>
    </div>
  );
};

export default Room;
