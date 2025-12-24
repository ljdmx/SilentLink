
import React, { useEffect, useRef } from 'react';
import { Participant, PrivacyFilter } from '../types';

interface VideoCardProps {
  participant: Participant;
  filter: PrivacyFilter;
}

const VideoCard: React.FC<VideoCardProps> = ({ participant, filter }) => {
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
    <div className={`relative aspect-video lg:aspect-square xl:aspect-video w-full rounded-[2rem] overflow-hidden bg-black/40 shadow-2xl border transition-all duration-500 ${participant.isHost ? 'border-primary/40 ring-2 ring-primary/20 ring-offset-4 ring-offset-[#0a0f14]' : 'border-white/5'}`}>
      <video 
        ref={videoRef}
        autoPlay 
        playsInline 
        muted={participant.isLocal}
        className={`w-full h-full object-cover transition-all duration-1000 ${filter === PrivacyFilter.BLUR ? 'blur-3xl scale-110' : ''} ${filter === PrivacyFilter.BLACK || filter === PrivacyFilter.MOSAIC ? 'opacity-0' : 'opacity-100'}`}
      />

      {filter === PrivacyFilter.MOSAIC && (
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover" />
      )}

      {filter === PrivacyFilter.BLACK && (
        <div className="absolute inset-0 bg-[#0d131a] flex flex-col items-center justify-center text-center p-8">
          <div className="size-16 lg:size-20 rounded-full bg-primary/10 flex items-center justify-center mb-4 text-primary border border-primary/20">
            <span className="material-symbols-outlined text-3xl lg:text-4xl">visibility_off</span>
          </div>
          <h3 className="text-sm lg:text-base font-black tracking-widest uppercase">Privacy Mode</h3>
        </div>
      )}

      {/* Overlays */}
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 via-black/20 to-transparent pointer-events-none"></div>
      
      <div className="absolute top-4 left-4 flex flex-wrap gap-2 max-w-[80%]">
        <div className="px-3 py-1.5 bg-black/40 backdrop-blur-xl rounded-xl text-[9px] lg:text-[10px] font-black uppercase tracking-widest flex items-center gap-2 border border-white/5 shadow-xl">
          <span className={`size-2 rounded-full ${participant.audioEnabled ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}></span>
          <span className="truncate max-w-[100px]">{participant.name} {participant.isLocal ? '(You)' : ''}</span>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 flex gap-2">
         {filter !== PrivacyFilter.NONE && (
            <div className="size-9 lg:size-10 rounded-xl bg-primary/80 backdrop-blur-xl flex items-center justify-center text-white shadow-lg shadow-primary/20">
                <span className="material-symbols-outlined text-sm">privacy_tip</span>
            </div>
         )}
         <div className={`size-9 lg:size-10 rounded-xl backdrop-blur-xl flex items-center justify-center shadow-lg ${participant.audioEnabled ? 'bg-white/10 text-white' : 'bg-red-500/80 text-white'}`}>
            <span className="material-symbols-outlined text-sm">{participant.audioEnabled ? 'mic' : 'mic_off'}</span>
         </div>
      </div>
    </div>
  );
};

export default VideoCard;
