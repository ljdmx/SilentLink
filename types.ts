
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

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface FileTransfer {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
}

export interface RoomConfig {
  roomId: string;
  passphrase: string;
  userName: string;
  recordingProtection: boolean;
  ephemeralSession: boolean;
  defaultFilter: PrivacyFilter;
}
