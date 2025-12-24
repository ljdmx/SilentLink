
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
  const [activePanel, setActivePanel] = useState<'chat' | 'file' | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<FileTransfer[]>([]);
  const [currentFilter, setCurrentFilter] = useState<PrivacyFilter>(config.defaultFilter);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const encryptionKeyRef = useRef<CryptoKey | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const initSession = async () => {
      encryptionKeyRef.current = await deriveKey(config.passphrase, config.roomId);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        addParticipant({ id: 'local', name: config.userName, isLocal: true, isHost: true, audioEnabled: true, videoEnabled: true, stream });
        
        // 修复：使用更可靠的协议转换逻辑，防止 HTTPS 下加载 ws:// 导致的安全性错误
        const wsProtocol = window.location.protocol.replace('http', 'ws');
        const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => ws.send(JSON.stringify({ type: 'join', roomId: config.roomId, name: config.userName }));
        ws.onmessage = async (e) => handleSignalingMessage(JSON.parse(e.data));
        ws.onerror = (err) => console.error("WebSocket Error:", err);
      } catch (err) {
        console.error("Session init failed:", err);
      }
    };
    initSession();
    return () => {
      wsRef.current?.close();
      pcRef.current?.close();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const handleSignalingMessage = async (msg: any) => {
    switch (msg.type) {
      case 'user-joined': setupPeerConnection(msg.userId, true); break;
      case 'offer':
        setupPeerConnection(msg.from, false);
        await pcRef.current!.setRemoteDescription(new RTCSessionDescription(msg.offer));
        const answer = await pcRef.current!.createAnswer();
        await pcRef.current!.setLocalDescription(answer);
        wsRef.current?.send(JSON.stringify({ type: 'answer', to: msg.from, answer }));
        break;
      case 'answer': await pcRef.current!.setRemoteDescription(new RTCSessionDescription(msg.answer)); break;
      case 'ice-candidate': await pcRef.current!.addIceCandidate(new RTCIceCandidate(msg.candidate)); break;
    }
  };

  const setupPeerConnection = (remoteId: string, isOffer: boolean) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pcRef.current = pc;
    localStreamRef.current?.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));
    pc.ontrack = (e) => addParticipant({ id: remoteId, name: "Remote", isLocal: false, isHost: false, audioEnabled: true, videoEnabled: true, stream: e.streams[0] });
    pc.onicecandidate = (e) => e.candidate && wsRef.current?.send(JSON.stringify({ type: 'ice-candidate', to: remoteId, candidate: e.candidate }));

    if (isOffer) {
      const dc = pc.createDataChannel('secure-transfer', { ordered: true });
      setupDataChannel(dc);
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        wsRef.current?.send(JSON.stringify({ type: 'offer', to: remoteId, offer }));
      });
    } else {
      pc.ondatachannel = (e) => setupDataChannel(e.channel);
    }
  };

  const setupDataChannel = (dc: RTCDataChannel) => {
    dcRef.current = dc;
    dc.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        const payload = JSON.parse(e.data);
        if (payload.type === 'chat') {
          const text = await decryptMessage(encryptionKeyRef.current!, payload.data, payload.iv);
          setMessages(prev => [...prev, { id: Date.now().toString(), senderId: 'remote', senderName: 'Peer', text, timestamp: Date.now() }]);
        } else if (payload.type === 'file-meta') handleFileMetaReceive(payload);
      } else handleFileChunkReceive(e.data);
    };
  };

  const addParticipant = (p: Participant) => setParticipants(prev => prev.find(u => u.id === p.id) ? prev : [...prev, p]);

  const sendMessage = async (text: string) => {
    if (!dcRef.current || dcRef.current.readyState !== 'open') return;
    const encrypted = await encryptMessage(encryptionKeyRef.current!, text);
    dcRef.current.send(JSON.stringify({ type: 'chat', ...encrypted }));
    setMessages(prev => [...prev, { id: Date.now().toString(), senderId: 'local', senderName: config.userName, text, timestamp: Date.now() }]);
  };

  const handleFileUpload = async (file: File) => {
    if (!dcRef.current || dcRef.current.readyState !== 'open') return;
    const fileId = Math.random().toString(36).substring(7);
    setFiles(prev => [{ id: fileId, name: file.name, size: file.size, progress: 0, status: 'transferring' }, ...prev]);
    dcRef.current.send(JSON.stringify({ type: 'file-meta', id: fileId, name: file.name, size: file.size }));
    const reader = file.stream().getReader();
    let offset = 0;
    while (true) {
      if (dcRef.current.bufferedAmount > 1024 * 1024) { await new Promise(r => setTimeout(r, 100)); continue; }
      const { done, value } = await reader.read();
      if (done) break;
      const { data, iv } = await encryptBuffer(encryptionKeyRef.current!, value.buffer);
      const packet = new Uint8Array(iv.length + data.byteLength);
      packet.set(iv, 0); packet.set(new Uint8Array(data), iv.length);
      dcRef.current.send(packet);
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
      {/* 氛围背景 */}
      <div className="absolute top-0 left-1/4 size-[500px] bg-primary/5 blur-[120px] rounded-full pointer-events-none"></div>

      {/* 顶部标题栏 */}
      <header className="h-12 lg:h-14 shrink-0 flex items-center justify-between px-4 lg:px-6 glass z-[60] border-b-0 m-2 rounded-xl lg:rounded-2xl">
        <div className="flex items-center gap-3 lg:gap-4 overflow-hidden">
          <div className="size-7 lg:size-8 bg-primary/10 rounded-lg flex items-center justify-center border border-primary/20 shrink-0">
            <span className="material-symbols-outlined text-primary text-sm lg:text-lg fill-1">verified_user</span>
          </div>
          <div className="overflow-hidden">
            <h2 className="text-[9px] lg:text-[10px] font-black tracking-[0.2em] text-gray-500 uppercase truncate">ID: {config.roomId}</h2>
            <div className="flex items-center gap-1.5">
               <span className="size-1 bg-accent rounded-full animate-pulse"></span>
               <span className="text-[8px] lg:text-[9px] font-bold text-accent uppercase tracking-widest whitespace-nowrap">Encrypted</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
            <button onClick={() => { navigator.clipboard.writeText(config.roomId); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000); }} 
                    className="h-7 lg:h-8 px-2 lg:px-3 rounded-lg bg-white/5 hover:bg-white/10 transition-all border border-white/5 text-[9px] lg:text-[10px] font-bold uppercase tracking-widest flex items-center gap-2">
                <span className="material-symbols-outlined text-xs lg:text-sm">{isCopied ? 'check' : 'share'}</span>
                <span className="hidden sm:inline">{isCopied ? '复制 ID' : '邀请'}</span>
            </button>
        </div>
      </header>

      {/* 视频网格区 - 增加底部内边距，确保不被控制条遮挡 */}
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
                    <h3 className="text-xl lg:text-2xl font-black tracking-tight text-white">等待对端接入...</h3>
                    <p className="text-gray-500 text-xs lg:text-sm max-w-xs mx-auto font-medium">节点已在内存中广播。将房间 ID 发送给您的伙伴以建立加密隧道。</p>
                </div>
            </div>
          ) : (
            <div className={`grid gap-3 lg:gap-4 h-full content-start justify-center ${participants.length <= 1 ? 'grid-cols-1 max-w-4xl mx-auto' : participants.length <= 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-2 lg:grid-cols-3'}`}>
              {participants.map(p => (
                <VideoCard key={p.id} participant={p} filter={p.isLocal ? currentFilter : PrivacyFilter.NONE} />
              ))}
            </div>
          )}
        </div>

        {/* 侧边面板 (聊天/文件) - 移动端全屏优化 */}
        <div className={`fixed inset-0 lg:static lg:inset-auto lg:w-80 glass lg:bg-transparent lg:backdrop-blur-none lg:border-l-0 transform transition-all duration-300 ease-in-out z-[110] flex flex-col lg:m-2 lg:rounded-2xl overflow-hidden ${activePanel ? 'translate-y-0 opacity-100' : 'translate-y-full lg:hidden opacity-0 scale-95 pointer-events-none'}`}>
             <div className="h-14 flex items-center justify-between px-6 border-b border-white/5 bg-black/40 lg:bg-white/2px shrink-0">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                    {activePanel === 'chat' ? '安全加密消息' : '端到端文件传输'}
                </h3>
                <button onClick={() => setActivePanel(null)} className="size-8 rounded-full hover:bg-white/5 flex items-center justify-center transition-colors">
                    <span className="material-symbols-outlined text-lg">close</span>
                </button>
             </div>
             <div className="flex-1 overflow-hidden bg-background lg:bg-transparent flex flex-col">
                {activePanel === 'chat' && <ChatBox messages={messages} onSend={sendMessage} userName={config.userName} />}
                {activePanel === 'file' && <FileExchange files={files} onUpload={handleFileUpload} />}
             </div>
        </div>
      </main>

      {/* 浮动控制中心 - 针对安全区域适配 */}
      <div className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] lg:bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2 lg:gap-3 p-2 lg:p-3 glass rounded-3xl lg:rounded-[2rem] z-[100] shadow-2xl shadow-black transition-all ${activePanel ? 'translate-y-24 opacity-0 scale-90 pointer-events-none' : 'translate-y-0 opacity-100'}`}>
        {/* 隐私滤镜组 */}
        <div className="flex items-center gap-1 bg-white/5 p-1 rounded-2xl mr-1 lg:mr-2">
            <FilterBtn active={currentFilter === PrivacyFilter.NONE} icon="visibility" onClick={() => setCurrentFilter(PrivacyFilter.NONE)} />
            <FilterBtn active={currentFilter === PrivacyFilter.MOSAIC} icon="grid_view" onClick={() => setCurrentFilter(PrivacyFilter.MOSAIC)} />
            <FilterBtn active={currentFilter === PrivacyFilter.BLACK} icon="videocam_off" onClick={() => setCurrentFilter(PrivacyFilter.BLACK)} />
        </div>

        <ControlBtn icon={isMuted ? 'mic_off' : 'mic'} active={!isMuted} onClick={toggleMute} danger={isMuted} />
        <ControlBtn icon={isVideoOff ? 'videocam_off' : 'videocam'} active={!isVideoOff} onClick={toggleVideo} danger={isVideoOff} />
        
        <div className="w-px h-6 bg-white/10 mx-1"></div>
        
        <ControlBtn icon="forum" active={activePanel === 'chat'} onClick={() => setActivePanel('chat')} />
        <ControlBtn icon="upload_file" active={activePanel === 'file'} onClick={() => setActivePanel('file')} />
        
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

const ChatBox = ({ messages, onSend, userName }: { messages: ChatMessage[]; onSend: (t: string) => void; userName: string }) => {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages]);

  return (
    <div className="flex flex-col h-full bg-background lg:bg-transparent">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 lg:space-y-6 custom-scrollbar">
        {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center opacity-10 text-center py-20">
                <span className="material-symbols-outlined text-6xl mb-4">encrypted</span>
                <p className="text-[10px] font-black uppercase tracking-[0.3em]">Channel Encrypted</p>
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
      {/* 底部输入框 - 确保其在移动端始终可见，增加安全区内边距 */}
      <div className="p-4 bg-black/80 lg:bg-white/2px border-t border-white/5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] lg:pb-4 shrink-0">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }} className="relative flex gap-2">
          <input 
            className="flex-1 h-11 lg:h-12 bg-white/5 border border-white/10 rounded-xl px-4 text-xs lg:text-sm focus:border-primary/50 outline-none transition-all placeholder:text-gray-700 text-white" 
            placeholder="输入加密消息..." 
            value={text} 
            onChange={(e) => setText(e.target.value)} 
            onFocus={() => {
                // 解决某些移动端软键盘遮挡问题
                setTimeout(() => scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 300);
            }}
          />
          <button type="submit" className="shrink-0 size-11 lg:size-12 bg-primary text-white rounded-xl flex items-center justify-center hover:bg-blue-600 transition-all active:scale-90 shadow-lg shadow-primary/20">
            <span className="material-symbols-outlined text-sm lg:text-[18px]">send</span>
          </button>
        </form>
      </div>
    </div>
  );
};

const FileExchange = ({ files, onUpload }: { files: FileTransfer[]; onUpload: (f: File) => void }) => {
  return (
    <div className="flex flex-col h-full bg-background lg:bg-transparent">
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 custom-scrollbar">
        {files.length === 0 && (
           <div className="h-full flex flex-col items-center justify-center text-center opacity-20 py-12">
              <span className="material-symbols-outlined text-5xl mb-4">cloud_off</span>
              <p className="text-[10px] font-bold uppercase tracking-widest">暂无传输任务</p>
           </div>
        )}
        {files.map(f => (
          <div key={f.id} className="p-3 lg:p-4 rounded-xl bg-white/5 border border-white/5 space-y-3">
             <div className="flex justify-between items-start">
                <div className="overflow-hidden pr-4">
                    <p className="text-[11px] lg:text-xs font-bold truncate text-gray-200">{f.name}</p>
                    <p className="text-[8px] lg:text-[9px] text-gray-600 font-mono mt-1">{(f.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    <span className="size-1 bg-primary rounded-full animate-pulse"></span>
                    <span className="text-[8px] lg:text-[9px] font-black text-primary uppercase">{f.status === 'completed' ? '完成' : `${f.progress}%`}</span>
                </div>
             </div>
             <div className="h-0.5 w-full bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300" style={{ width: `${f.progress}%` }}></div>
             </div>
          </div>
        ))}
      </div>
      <div className="p-4 bg-black/80 lg:bg-white/2px border-t border-white/5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] lg:pb-4 shrink-0">
        <label className="flex items-center justify-center w-full h-12 lg:h-14 bg-primary/5 border border-dashed border-primary/20 rounded-xl cursor-pointer hover:bg-primary/10 hover:border-primary/40 transition-all gap-3 text-primary">
            <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
            <span className="material-symbols-outlined text-sm lg:text-base">add_circle</span>
            <span className="text-[10px] lg:text-xs font-bold uppercase tracking-widest">分片传输大文件</span>
        </label>
      </div>
    </div>
  );
};

export default Room;
