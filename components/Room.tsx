
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RoomConfig, Participant, PrivacyFilter, ChatMessage, FileTransfer, ReceivingFileState, FileMetaPayload } from '../types';
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
  const [showLocalPreview, setShowLocalPreview] = useState(true);
  const [toast, setToast] = useState<{msg: string; type: 'info' | 'error'} | null>(null);
  
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
  const isMutedRef = useRef(isMuted);
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const processedOfferRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string, type: 'info' | 'error' = 'info') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ msg, type });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const cleanupResources = useCallback(() => {
    peersRef.current.forEach(pc => pc.close());
    peersRef.current.clear();
    dataChannelsRef.current.clear();
    rawStreamRef.current?.getTracks().forEach(t => t.stop());
    processedStreamRef.current?.getTracks().forEach(t => t.stop());
    blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    blobUrlsRef.current.clear();
  }, []);

  const handleManualExit = useCallback(() => {
    const termMsg = JSON.stringify({ type: 'session-terminate' });
    dataChannelsRef.current.forEach(dc => {
      if (dc.readyState === 'open') dc.send(termMsg);
    });
    cleanupResources();
    onExit();
  }, [cleanupResources, onExit]);

  const addOrUpdateParticipant = useCallback((p: Participant) => {
    setParticipants(prev => {
      const exists = prev.find(u => u.id === p.id);
      if (exists) {
        if (JSON.stringify(exists) === JSON.stringify(p)) return prev;
        return prev.map(u => u.id === p.id ? { ...u, ...p } : u);
      }
      return [...prev, p];
    });
  }, []);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const initMedia = async () => {
      encryptionKeyRef.current = await deriveKey(config.passphrase, config.roomId);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }, 
          audio: true 
        });
        rawStreamRef.current = stream;
        const canvas = filterCanvasRef.current;
        const canvasStream = (canvas as any).captureStream(30);
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !isMutedRef.current;
          canvasStream.addTrack(audioTrack);
        }
        processedStreamRef.current = canvasStream;
        addOrUpdateParticipant({ 
          id: 'local', 
          name: config.userName, 
          isLocal: true, 
          isHost: true, 
          audioEnabled: !isMutedRef.current, 
          videoEnabled: filterRef.current === PrivacyFilter.NONE, 
          stream: canvasStream 
        });
      } catch (err) {
        showToast("无法获取本地媒体权限", "error");
      }
    };
    initMedia();
    return () => cleanupResources();
  }, [config.roomId, config.userName, config.passphrase, addOrUpdateParticipant, showToast, cleanupResources]);

  useEffect(() => {
    if (role !== 'none') setHandshakeTimer(180);
  }, [role]);

  useEffect(() => {
    let interval: number;
    if (role !== 'none' && connectionStatus !== 'connected' && handshakeTimer > 0) {
      interval = window.setInterval(() => {
        setHandshakeTimer(prev => {
          if (prev <= 1) {
            clearInterval(interval);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [role, connectionStatus, handshakeTimer]);

  useEffect(() => {
    let animationFrame: number;
    let lastWidth = 0;
    let lastHeight = 0;
    const canvas = filterCanvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;

    const render = () => {
      if (ctx && video.readyState >= 2 && rawStreamRef.current) {
        if (video.videoWidth !== lastWidth || video.videoHeight !== lastHeight) {
          canvas.width = lastWidth = video.videoWidth;
          canvas.height = lastHeight = video.videoHeight;
        }
        const filter = filterRef.current;
        if (filter === PrivacyFilter.BLACK) {
          ctx.fillStyle = '#06080a';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else if (filter === PrivacyFilter.MOSAIC) {
          const scale = 0.02; 
          const w = Math.max(1, canvas.width * scale);
          const h = Math.max(1, canvas.height * scale);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(video, 0, 0, w, h);
          ctx.filter = 'blur(10px)'; 
          ctx.drawImage(canvas, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
          ctx.filter = 'none';
        } else {
          ctx.drawImage(video, 0, 0);
        }
      }
      animationFrame = requestAnimationFrame(render);
    };

    const checker = setInterval(() => {
      if (rawStreamRef.current && video.srcObject !== rawStreamRef.current) {
        video.srcObject = rawStreamRef.current;
        video.play().then(() => render()).catch(() => {});
      }
    }, 500);

    return () => {
      cancelAnimationFrame(animationFrame);
      clearInterval(checker);
    };
  }, []);

  const syncMyPrivacyState = useCallback((filter: PrivacyFilter, muted: boolean) => {
    const payload = JSON.stringify({ 
      type: 'privacy-update', 
      filter, 
      audioEnabled: !muted,
      videoEnabled: filter === PrivacyFilter.NONE 
    });
    dataChannelsRef.current.forEach(dc => {
      if (dc.readyState === 'open') dc.send(payload);
    });
    setParticipants(prev => prev.map(p => p.isLocal ? { ...p, audioEnabled: !muted, videoEnabled: filter === PrivacyFilter.NONE } : p));
  }, []);

  useEffect(() => { 
    filterRef.current = currentFilter; 
    if (connectionStatus === 'connected') {
      syncMyPrivacyState(currentFilter, isMuted);
    }
  }, [currentFilter, isMuted, connectionStatus, syncMyPrivacyState]);

  const setupPeerConnection = async (remoteId: string, isOffer: boolean): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection({ 
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
      ],
      iceCandidatePoolSize: 10
    });

    peersRef.current.set(remoteId, pc);

    if (processedStreamRef.current) {
      processedStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, processedStreamRef.current!);
      });
    }

    pc.ontrack = (e) => {
      addOrUpdateParticipant({ 
        id: remoteId, 
        name: "远端节点", 
        isLocal: false, 
        isHost: false, 
        audioEnabled: true, 
        videoEnabled: true, 
        stream: e.streams[0] 
      });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        setTimeout(() => {
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            handleManualExit();
          }
        }, 5000);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnectionStatus('connected');
        syncMyPrivacyState(filterRef.current, isMutedRef.current);
      }
      if (['closed'].includes(pc.connectionState)) handleManualExit();
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
          } else if (payload.type === 'privacy-update') {
            setParticipants(prev => prev.map(p => 
              p.id === remoteId ? { ...p, audioEnabled: payload.audioEnabled, videoEnabled: payload.videoEnabled } : p
            ));
          } else if (payload.type === 'file-meta') {
            handleFileMetaReceive(payload);
          } else if (payload.type === 'file-abort') {
            showToast("文件传输取消", "error");
            setFiles(prev => prev.map(f => f.id === payload.id ? { ...f, status: 'failed' } : f));
          } else if (payload.type === 'session-terminate') {
            handleManualExit();
          }
        } catch (err) { console.error("Protocol error:", err); }
      } else handleFileChunkReceive(e.data);
    };
  };

  const startAsInitiator = async () => {
    if (!processedStreamRef.current) return showToast("正在初始化媒体，请稍候...", "info");
    
    // 立即进入页面
    setRole('initiator');
    setHandshakeStep(2);
    setConnectionStatus('preparing');
    
    try {
      const pc = await setupPeerConnection('peer', true);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
          setConnectionStatus('ready');
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      // 快速检查
      if (pc.iceGatheringState === 'complete') {
        setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
        setConnectionStatus('ready');
      }
    } catch (e) {
      showToast("无法创建握手请求", "error");
      setRole('none');
    }
  };

  const handleOfferAndReply = useCallback(async (forcedOffer?: string) => {
    const offerStr = forcedOffer || remoteSDPInput;
    if (!offerStr) return;
    
    if (!processedStreamRef.current) {
        setTimeout(() => handleOfferAndReply(forcedOffer), 500);
        return;
    }

    if (processedOfferRef.current === offerStr) return;
    processedOfferRef.current = offerStr;
    
    // 立即进入响应状态 UI
    setHandshakeStep(2);
    setConnectionStatus('preparing');
    
    try {
      const offer = JSON.parse(atob(offerStr));
      const pc = await setupPeerConnection('peer', false);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
          setConnectionStatus('ready');
        }
      };
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      if (pc.iceGatheringState === 'complete') {
        setLocalSDP(btoa(JSON.stringify(pc.localDescription)));
        setConnectionStatus('ready');
      }
    } catch (e) { 
      showToast("无效的请求包", "error");
      processedOfferRef.current = null;
      setHandshakeStep(1);
    }
  }, [remoteSDPInput, showToast]);

  const finalizeAsInitiator = async () => {
    if (!remoteSDPInput) return;
    try {
      const answer = JSON.parse(atob(remoteSDPInput));
      const pc = peersRef.current.get('peer');
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) { showToast("响应包无效", "error"); }
  };

  useEffect(() => {
    if (config.initialOffer && role === 'receiver' && connectionStatus === 'idle') {
      const timer = setTimeout(() => handleOfferAndReply(config.initialOffer), 800);
      return () => clearTimeout(timer);
    }
  }, [config.initialOffer, role, connectionStatus, handleOfferAndReply]);

  const createAndTrackBlobUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    blobUrlsRef.current.add(url);
    return url;
  };

  const sendMessage = async (text: string) => {
    if (!encryptionKeyRef.current) return;
    try {
      const encrypted = await encryptMessage(encryptionKeyRef.current, text);
      const payload = JSON.stringify({ type: 'chat', ...encrypted });
      let anySent = false;
      dataChannelsRef.current.forEach(dc => {
        if (dc.readyState === 'open') {
          dc.send(payload);
          anySent = true;
        }
      });
      if (anySent) {
        setMessages(prev => [...prev, { id: Date.now().toString(), senderId: 'local', senderName: config.userName, text, type: 'text', timestamp: Date.now() }]);
      } else {
        showToast("隧道断开，无法发送", "error");
      }
    } catch (e) { console.error(e); }
  };

  const handleFileUpload = async (file: File) => {
    if (!encryptionKeyRef.current) return;
    const fileId = Math.random().toString(36).substring(7);
    const meta: FileMetaPayload = { type: 'file-meta', id: fileId, name: file.name, size: file.size, mimeType: file.type };
    let anyOpen = false;
    dataChannelsRef.current.forEach(dc => { if(dc.readyState === 'open') { dc.send(JSON.stringify(meta)); anyOpen = true; }});
    if (!anyOpen) return showToast("未检测到连接", "error");
    setFiles(prev => [{ id: fileId, name: file.name, size: file.size, progress: 0, status: 'transferring', mimeType: file.type }, ...prev]);
    try {
      const buffer = await file.arrayBuffer();
      const CHUNK_SIZE = 16384;
      let offset = 0;
      const sendNext = async () => {
        if (offset >= buffer.byteLength) {
          const blobUrl = createAndTrackBlobUrl(new Blob([buffer], { type: file.type }));
          setMessages(prev => [...prev, { id: fileId, senderId: 'local', senderName: config.userName, blobUrl, type: file.type.startsWith('image/') ? 'image' : 'file', fileName: file.name, timestamp: Date.now() }]);
          setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'completed' } : f));
          return;
        }
        try {
          const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
          const { data, iv } = await encryptBuffer(encryptionKeyRef.current!, chunk);
          const packet = new Uint8Array(iv.length + data.byteLength);
          packet.set(iv, 0); packet.set(new Uint8Array(data), iv.length);
          let chunkSent = false;
          dataChannelsRef.current.forEach(dc => {
            if (dc.readyState === 'open' && dc.bufferedAmount < 256 * 1024) {
              dc.send(packet);
              chunkSent = true;
            }
          });
          if (!chunkSent) { setTimeout(sendNext, 50); return; }
          offset += CHUNK_SIZE;
          setFiles(prev => prev.map(f => f.id === fileId ? { ...f, progress: Math.min(100, Math.round((offset/file.size)*100)) } : f));
          setTimeout(sendNext, 1);
        } catch (innerErr) {
          dataChannelsRef.current.forEach(dc => dc.readyState === 'open' && dc.send(JSON.stringify({type: 'file-abort', id: fileId})));
          setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'failed' } : f));
        }
      };
      sendNext();
    } catch (err) { setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'failed' } : f)); }
  };

  const receivingRef = useRef<ReceivingFileState | null>(null);
  const handleFileMetaReceive = (meta: FileMetaPayload) => {
    receivingRef.current = { ...meta, chunks: [], received: 0 };
    setFiles(prev => [{ id: meta.id, name: meta.name, size: meta.size, progress: 0, status: 'transferring', mimeType: meta.mimeType }, ...prev]);
  };

  const handleFileChunkReceive = async (data: ArrayBuffer) => {
    const s = receivingRef.current; if (!s) return;
    try {
      const iv = new Uint8Array(data.slice(0, 12));
      const dec = await decryptBuffer(encryptionKeyRef.current!, data.slice(12), iv);
      s.chunks.push(dec); s.received += dec.byteLength;
      setFiles(prev => prev.map(f => f.id === s.id ? { ...f, progress: Math.min(100, Math.round((s.received/s.size)*100)) } : f));
      if (s.received >= s.size) {
        const blobUrl = createAndTrackBlobUrl(new Blob(s.chunks, { type: s.mimeType }));
        setMessages(prev => [...prev, { id: s.id, senderId: 'peer', senderName: '对方', blobUrl, type: s.mimeType?.startsWith('image/') ? 'image' : 'file', fileName: s.name, timestamp: Date.now() }]);
        setFiles(prev => prev.map(f => f.id === s.id ? { ...f, status: 'completed' } : f));
        receivingRef.current = null;
      }
    } catch (err) {
      setFiles(prev => prev.map(f => f.id === s.id ? { ...f, status: 'failed' } : f));
      receivingRef.current = null;
    }
  };

  const getInviteLink = () => {
    const url = new URL(window.location.href.split('#')[0]);
    url.hash = `room=${config.roomId}&pass=${config.passphrase}&offer=${localSDP}`;
    return url.toString();
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden relative font-sans">
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[1000] animate-in fade-in slide-in-from-top-4 duration-300">
           <div className={`px-6 py-3 rounded-2xl glass shadow-2xl flex items-center gap-3 border ${toast.type === 'error' ? 'border-red-500/20 text-red-400' : 'border-primary/20 text-primary'}`}>
              <span className="material-symbols-outlined text-sm">{toast.type === 'error' ? 'error' : 'info'}</span>
              <span className="text-xs font-black uppercase tracking-widest">{toast.msg}</span>
           </div>
        </div>
      )}

      <header className="h-12 lg:h-14 shrink-0 flex items-center justify-between px-3 lg:px-6 glass z-[60] m-2 rounded-xl border-none">
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
        <button onClick={handleManualExit} className="h-7 lg:h-8 px-3 lg:px-4 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[8px] lg:text-[10px] font-black uppercase tracking-widest transition-all">物理退出</button>
      </header>

      <main className="flex-1 flex overflow-hidden relative p-2 pt-0 gap-2">
        <div className="flex-1 flex flex-col relative overflow-hidden bg-black/60 rounded-2xl border border-white/5 shadow-inner">
          {connectionStatus !== 'connected' ? (
            <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-12 space-y-6 animate-in fade-in duration-700 overflow-y-auto">
                {role === 'none' ? (
                    <div className="text-center space-y-8 max-w-2xl w-full px-4">
                        <div className="space-y-3">
                            <h3 className="text-3xl lg:text-5xl font-black text-white tracking-tighter uppercase italic leading-none">安全隧道待命中</h3>
                            <p className="text-gray-500 text-[9px] lg:text-[10px] font-black uppercase tracking-[0.4em]">请启动端对端握手</p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6 w-full max-w-3xl">
                            <button onClick={startAsInitiator} className="group flex flex-col items-center gap-4 p-8 glass rounded-[2rem] border-primary/10 hover:border-primary/40 transition-all shadow-xl active:scale-95">
                                <span className="material-symbols-outlined text-4xl lg:text-5xl text-primary animate-pulse">send_time_extension</span>
                                <h4 className="text-sm lg:text-xl font-black text-white uppercase tracking-widest">作为发起方</h4>
                            </button>
                            <button onClick={() => setRole('receiver')} className="group flex flex-col items-center gap-4 p-8 glass rounded-[2rem] border-accent/10 hover:border-accent/40 transition-all shadow-xl active:scale-95">
                                <span className="material-symbols-outlined text-4xl lg:text-5xl text-accent">hail</span>
                                <h4 className="text-sm lg:text-xl font-black text-white uppercase tracking-widest">作为接收方</h4>
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="w-full max-w-3xl relative px-4">
                        <div className={`glass rounded-[2rem] lg:rounded-[3.5rem] p-6 lg:p-14 bg-black/80 border-t-8 transition-all ${role === 'initiator' ? 'border-t-primary' : 'border-t-accent'}`}>
                            <div className="flex items-center justify-between mb-8 opacity-60">
                                <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-widest">握手窗口</div>
                                <span className={`text-sm font-mono font-black ${handshakeTimer < 30 ? 'text-red-500 animate-pulse' : 'text-primary'}`}>
                                    {Math.floor(handshakeTimer/60)}:{(handshakeTimer%60).toString().padStart(2, '0')}
                                </span>
                            </div>
                            {role === 'initiator' ? (
                                <div className="space-y-6">
                                    <div className="space-y-8">
                                        <div className="space-y-4">
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-left text-gray-400">STEP 1: 复制并发送请求链接</h4>
                                            <button 
                                              disabled={!localSDP}
                                              onClick={() => {if(localSDP){navigator.clipboard.writeText(getInviteLink()); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}}} 
                                              className="w-full h-14 bg-primary/10 border-2 border-primary/20 hover:border-primary text-primary rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50"
                                            >
                                                <span className="material-symbols-outlined text-xl">{localSDP ? (isCopied ? 'done_all' : 'content_copy') : 'sync'}</span>
                                                <span>{localSDP ? (isCopied ? '链接已复制' : '复制安全请求链接') : '正在计算加密载荷...'}</span>
                                            </button>
                                        </div>
                                        <div className="space-y-4">
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-left text-gray-400">STEP 2: 粘贴对方响应代码</h4>
                                            <div className="relative">
                                                <textarea placeholder="粘贴响应代码..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-24 bg-black/40 border border-white/5 rounded-2xl p-4 text-[10px] font-mono text-accent outline-none resize-none placeholder:text-gray-700" />
                                                <button onClick={finalizeAsInitiator} disabled={!remoteSDPInput} className="absolute bottom-3 right-3 h-10 px-6 bg-accent text-black rounded-xl text-[10px] font-black uppercase active:scale-95 disabled:opacity-20 transition-all">开启隧道</button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-8">
                                    {handshakeStep === 1 ? (
                                        <div className="space-y-4">
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-left text-gray-400">注入请求代码</h4>
                                            <textarea placeholder="粘贴发起方的加密载荷..." value={remoteSDPInput} onChange={(e) => setRemoteSDPInput(e.target.value)} className="w-full h-24 bg-black/40 border border-white/5 rounded-2xl p-4 text-[10px] font-mono text-accent outline-none resize-none placeholder:text-gray-700" />
                                            <button onClick={() => handleOfferAndReply()} disabled={!remoteSDPInput} className="w-full h-14 bg-white/5 border border-white/10 text-white rounded-2xl text-xs font-black uppercase hover:bg-white/10 transition-all active:scale-95 disabled:opacity-30">计算响应</button>
                                        </div>
                                    ) : (
                                        <div className="space-y-4">
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-left text-gray-400">STEP 2: 返回响应代码</h4>
                                            <button 
                                              disabled={!localSDP}
                                              onClick={() => {if(localSDP){navigator.clipboard.writeText(localSDP); setIsCopied(true); setTimeout(()=>setIsCopied(false), 2000);}}} 
                                              className="w-full h-14 bg-accent text-black rounded-2xl text-xs font-black uppercase active:scale-95 transition-all disabled:opacity-50"
                                            >
                                                <span className="material-symbols-outlined mr-2">{localSDP ? (isCopied ? 'done_all' : 'content_copy') : 'sync'}</span>
                                                {localSDP ? (isCopied ? '响应包已复制' : '复制响应代码') : '正在生成响应包...'}
                                            </button>
                                            <button onClick={() => setHandshakeStep(1)} className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-white transition-colors">重新输入</button>
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
                  <div className="w-full h-full flex flex-col items-center justify-center space-y-6 opacity-30">
                    <div className="size-12 lg:size-16 rounded-full border-4 border-primary/10 border-t-primary animate-spin"></div>
                    <p className="text-[10px] lg:text-xs font-black uppercase tracking-[0.4em] text-white font-mono">ENCRYPTING LINK...</p>
                  </div>
                )}
              </div>
              {showLocalPreview && localParticipant && (
                <div className="absolute bottom-28 lg:bottom-10 left-4 lg:left-8 w-28 lg:w-64 aspect-video z-50 border-2 border-white/20 rounded-xl lg:rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.5)] transition-all animate-in fade-in zoom-in-95">
                  <VideoCard participant={localParticipant} filter={currentFilter} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className={`fixed inset-0 lg:static lg:inset-auto lg:w-[320px] xl:w-[400px] 2xl:w-[450px] glass transform transition-all duration-300 z-[200] flex flex-col lg:rounded-2xl overflow-hidden ${isChatOpen ? 'translate-y-0 opacity-100' : 'translate-y-full lg:hidden opacity-0 pointer-events-none'}`}>
             <div className="h-14 flex items-center justify-between px-6 border-b border-white/5 bg-black/90 shrink-0">
                <div className="flex items-center gap-2.5">
                    <span className="size-2 rounded-full bg-accent animate-pulse"></span>
                    <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-white/90">E2EE TUNNEL</h3>
                </div>
                <button onClick={() => setIsChatOpen(false)} aria-label="关闭聊天" className="size-10 rounded-full hover:bg-white/5 flex items-center justify-center text-gray-500 transition-all active:scale-90">
                    <span className="material-symbols-outlined text-2xl">close</span>
                </button>
             </div>
             <div className="flex-1 overflow-hidden bg-[#0a0c0e] flex flex-col relative">
                <ChatBox messages={messages} onSend={sendMessage} onUpload={handleFileUpload} />
             </div>
        </div>
      </main>

      {connectionStatus === 'connected' && (
        <div className={`fixed bottom-4 lg:bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-1.5 lg:gap-8 p-2 lg:p-4 glass rounded-[2.5rem] lg:rounded-[3.5rem] shadow-[0_30px_60px_-15px_rgba(0,0,0,0.8)] border border-white/10 transition-all duration-300 ${isChatOpen ? 'opacity-0 pointer-events-none lg:opacity-100 lg:pointer-events-auto z-10' : 'z-[120] opacity-100'}`}>
          <div className="flex items-center gap-1 lg:gap-3 px-1.5">
            <ControlBtn icon={isMuted ? 'mic_off' : 'mic'} active={!isMuted} onClick={() => setIsMuted(!isMuted)} danger={isMuted} label="静音" />
            <ControlBtn icon="blur_on" active={currentFilter === PrivacyFilter.MOSAIC} onClick={() => setCurrentFilter(prev => prev === PrivacyFilter.MOSAIC ? PrivacyFilter.NONE : PrivacyFilter.MOSAIC)} label="马赛克" />
            <ControlBtn icon={currentFilter === PrivacyFilter.BLACK ? 'visibility_off' : 'videocam'} active={currentFilter !== PrivacyFilter.BLACK} onClick={() => setCurrentFilter(prev => prev === PrivacyFilter.BLACK ? PrivacyFilter.NONE : PrivacyFilter.BLACK)} danger={currentFilter === PrivacyFilter.BLACK} label="屏蔽" />
            <ControlBtn icon={showLocalPreview ? 'picture_in_picture' : 'picture_in_picture_alt'} active={showLocalPreview} onClick={() => setShowLocalPreview(!showLocalPreview)} label="预览" />
          </div>
          <div className="w-px h-8 bg-white/10 mx-1"></div>
          <div className="flex items-center gap-1 lg:gap-3 px-1.5">
            <ControlBtn icon={isRemoteMuted ? 'volume_off' : 'volume_up'} active={!isRemoteMuted} onClick={() => setIsRemoteMuted(!isRemoteMuted)} danger={isRemoteMuted} label="听众" />
            <ControlBtn icon={isRemoteHidden ? 'hide' : 'person'} active={!isRemoteHidden} onClick={() => setIsRemoteHidden(!isRemoteHidden)} danger={isRemoteHidden} label="视线" />
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
      aria-label={label}
      aria-pressed={active}
      className={`relative size-10 lg:size-14 rounded-full flex items-center justify-center transition-all border ${active ? 'bg-primary/10 border-primary/30 text-primary' : (danger ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-white/5 border-white/5 text-gray-500')} hover:scale-110 active:scale-90 shadow-sm`}
    >
      <span className="material-symbols-outlined text-[20px] lg:text-[26px]">{icon}</span>
      {badge && <span className="absolute top-0 right-0 size-2 bg-primary rounded-full ring-2 ring-black"></span>}
    </button>
    <span className="text-[7px] lg:text-[10px] font-black uppercase text-gray-600 hidden md:block tracking-widest">{label}</span>
  </div>
);

const ChatBox = ({ messages, onSend, onUpload }: { messages: ChatMessage[]; onSend: (t: string) => void; onUpload: (f: File) => void }) => {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);
  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } };
  
  return (
    <div className="flex flex-col h-full bg-[#080a0c]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 pb-28 lg:pb-32 custom-scrollbar">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center opacity-20 py-20 grayscale">
            <span className="material-symbols-outlined text-5xl mb-4">vpn_lock</span>
            <p className="text-[11px] font-black uppercase tracking-[0.4em]">安全端对端隧道已建立</p>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col ${m.senderId === 'local' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2`}>
             <div className="flex items-center gap-2 mb-1 px-1">
                <span className="text-[9px] font-black uppercase text-gray-500">{m.senderName}</span>
                <span className="text-[7px] font-mono text-gray-700 opacity-50">{new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
             </div>
             <div className={`rounded-2xl max-w-[90%] overflow-hidden shadow-xl ${m.senderId === 'local' ? 'bg-primary text-white rounded-tr-none' : 'bg-[#1a1f26] border border-white/10 text-gray-200 rounded-tl-none'}`}>
               {m.type === 'text' && <p className="px-4 py-2.5 text-[13px] leading-relaxed break-words">{m.text}</p>}
               {m.blobUrl && (
                 <div className="relative group min-w-[200px]">
                    {m.type === 'image' ? <img src={m.blobUrl} className="w-full h-auto max-h-[400px] object-cover" /> : (
                      <div className="p-4 flex items-center gap-4 bg-black/20">
                        <span className="material-symbols-outlined text-primary text-xl">link</span>
                        <div className="flex flex-col min-w-0">
                          <span className="text-[11px] font-bold truncate text-white">{m.fileName}</span>
                          <span className="text-[8px] opacity-30 uppercase tracking-tighter">SECURE BINARY</span>
                        </div>
                      </div>
                    )}
                    <a href={m.blobUrl} download={m.fileName} aria-label="下载文件" className="absolute bottom-2 right-2 size-10 bg-black/80 rounded-xl flex items-center justify-center text-white border border-white/10 hover:bg-primary transition-all"><span className="material-symbols-outlined text-lg">download</span></a>
                 </div>
               )}
             </div>
          </div>
        ))}
      </div>
      <div className="absolute bottom-0 inset-x-0 p-4 lg:p-6 bg-gradient-to-t from-black via-black/95 to-transparent backdrop-blur-sm border-t border-white/5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <form onSubmit={handleSubmit} className="flex gap-3 items-center">
          <label aria-label="上传文件" className="shrink-0 size-11 bg-white/5 border border-white/10 text-gray-400 rounded-xl flex items-center justify-center cursor-pointer active:scale-95 hover:bg-white/10 transition-colors"><input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} /><span className="material-symbols-outlined text-xl">link</span></label>
          <input className="flex-1 h-11 bg-white/5 border border-white/10 rounded-xl px-4 text-[13px] text-white focus:outline-none focus:border-primary/50 transition-all placeholder:text-gray-600" placeholder="发送加密消息..." value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" aria-label="发送消息" disabled={!text.trim()} className="shrink-0 size-11 bg-primary text-white rounded-xl flex items-center justify-center disabled:opacity-20 active:scale-95 shadow-lg shadow-primary/30 transition-all"><span className="material-symbols-outlined text-xl">arrow_upward</span></button>
        </form>
      </div>
    </div>
  );
};

export default Room;
