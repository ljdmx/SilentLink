
export enum ViewMode {
  LANDING = 'LANDING',
  SETUP = 'SETUP',
  ROOM = 'ROOM',
  DESIGN = 'DESIGN'
}

export enum PrivacyFilter {
  NONE = 'NONE',
  BLUR = 'BLUR',
  MOSAIC = 'MOSAIC',
  BLACK = 'BLACK'
}

export interface Participant {
  id: string;
  name: string;
  isLocal: boolean;
  isHost: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  stream?: MediaStream;
}

export type MessageType = 'text' | 'image' | 'video' | 'file';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text?: string;
  blobUrl?: string;
  fileName?: string;
  type: MessageType;
  timestamp: number;
}

export interface FileTransfer {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  mimeType?: string;
}

export interface ReceivingFileState {
  id: string;
  name: string;
  size: number;
  received: number;
  chunks: ArrayBuffer[];
  mimeType?: string;
}

export interface FileMetaPayload {
  type: 'file-meta';
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface RoomConfig {
  roomId: string;
  passphrase: string;
  userName: string;
  recordingProtection: boolean;
  ephemeralSession: boolean;
  defaultFilter: PrivacyFilter;
  initialOffer?: string;
}
