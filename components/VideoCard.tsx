
import React, { useEffect, useRef } from 'react';
import { Participant, PrivacyFilter } from '../types';

interface VideoCardProps {
  participant: Participant;
  filter: PrivacyFilter;
  isLarge?: boolean;
}

const VideoCard: React.FC<VideoCardProps> = ({ participant, filter, isLarge }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (videoRef.current && participant.stream) {
      videoRef.current.srcObject = participant.stream;
    }
  }, [participant.stream]);

  useEffect(() => {
    if (filter === PrivacyFilter.MOSAIC && videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { alpha: false });
      let animationFrame: number;
      
      const render = () => {
        if (ctx && video.readyState >= 2) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const scale = 0.05;
          const w = canvas.width * scale;
          const h = canvas.height * scale;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(video, 0, 0, w, h);
          ctx.drawImage(canvas, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
        }
        animationFrame = requestAnimationFrame(render);
      };
      render();
      return () => cancelAnimationFrame(animationFrame);
    }
  }, [filter]);

  return (
    <div className={`relative w-full h-full overflow-hidden transition-all duration-700 bg-[#06080a] ${isLarge ? '' : 'rounded-2xl border border-white/10 shadow-3xl'}`}>
      <video 
        ref={videoRef}
        autoPlay 
        playsInline 
        muted={participant.isLocal}
        className={`w-full h-full object-cover transition-all duration-1000 ${filter === PrivacyFilter.BLUR ? 'blur-[80px] scale-110' : ''} ${filter === PrivacyFilter.BLACK || filter === PrivacyFilter.MOSAIC ? 'opacity-0' : 'opacity-100'}`}
      />

      {filter === PrivacyFilter.MOSAIC && (
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover" />
      )}

      {filter === PrivacyFilter.BLACK && (
        <div className="absolute inset-0 bg-[#0d131a] flex flex-col items-center justify-center text-center p-8">
          <div className="size-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 text-primary border border-primary/20">
            <span className="material-symbols-outlined text-3xl">visibility_off</span>
          </div>
          {!participant.isLocal && (
             <h3 className="text-[10px] font-black tracking-widest uppercase text-gray-400">Privacy Mode Active</h3>
          )}
        </div>
      )}

      {/* 渐变遮罩 - 仅对远端显示 */}
      {!participant.isLocal && (
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/80 to-transparent pointer-events-none"></div>
      )}
      
      {/* 名字标签 - 仅对远端显示 */}
      {!participant.isLocal && (
        <div className="absolute top-4 left-4 flex flex-wrap gap-2 max-w-[80%] z-10">
          <div className="px-3 py-1.5 bg-black/60 backdrop-blur-xl rounded-xl text-[9px] font-black uppercase tracking-widest flex items-center gap-2 border border-white/5 shadow-xl">
            <span className={`size-1.5 rounded-full ${participant.audioEnabled ? 'bg-accent shadow-[0_0_6px_rgba(34,197,94,0.6)]' : 'bg-red-500 animate-pulse'}`}></span>
            <span className="truncate max-w-[150px] text-white/90">{participant.name}</span>
          </div>
        </div>
      )}

      {/* 状态指示器 - 去除右下角语音图标，仅在隐私滤镜开启时对远端显示状态 */}
      {!participant.isLocal && filter !== PrivacyFilter.NONE && (
        <div className="absolute bottom-4 right-4 flex gap-2 z-10">
            <div className="size-9 rounded-xl bg-primary/20 backdrop-blur-xl flex items-center justify-center text-primary shadow-lg border border-primary/20">
                <span className="material-symbols-outlined text-[18px]">privacy_tip</span>
            </div>
        </div>
      )}
    </div>
  );
};

export default VideoCard;
