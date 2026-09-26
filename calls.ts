import { mediaDevices, MediaStream, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import type { IceServer } from '@rayed/api-client';
import { emitWithAck } from '@rayed/api-client';
import { api, socket } from '../lib/api';

const V1 = '/api/v1';
const emitAck = <T = Record<string, unknown>>(event: string, payload: unknown) => emitWithAck<T>(socket, event, payload);

/**
 * Internet calls between captain and customer over WebRTC (audio only).
 * Signalling protocol (server relays call:* events):
 *  1. caller → call:invite {tripId} → ack {callId, iceServers, ringTimeoutS}
 *  2. callee receives call:incoming, answers with call:accept {callId}
 *  3. caller receives call:accepted, creates the SDP offer → call:signal {type:'offer'}
 *  4. callee answers → call:signal {type:'answer'}; both trickle ICE candidates
 *  5. either side → call:end {callId, reason}; callee may call:decline
 * Signals that arrive before the peer connection exists are buffered.
 */

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  tripId: string | null;
  peerName: string | null;
  direction: 'outgoing' | 'incoming' | null;
  muted: boolean;
  connectedAt: number | null;
  message: string | null;
}

type SignalData =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } };

export interface IncomingCallPayload {
  callId: string;
  tripId: string;
  fromName: string | null;
  fromRole: string;
  iceServers: IceServer[];
}

const IDLE: CallState = {
  phase: 'idle',
  callId: null,
  tripId: null,
  peerName: null,
  direction: null,
  muted: false,
  connectedAt: null,
  message: null,
};

const END_MESSAGES: Record<string, string> = {
  DECLINED: 'رفض الكابتن المكالمة',
  TIMEOUT: 'لم يتم الرد',
  FAILED: 'انقطع الاتصال',
  HANGUP: 'انتهت المكالمة',
  BUSY: 'الخط مشغول',
};

type Listener = (state: CallState) => void;

class CallManager {
  private state: CallState = IDLE;
  private listeners = new Set<Listener>();
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private iceServers: IceServer[] = [];
  private pendingSignals: SignalData[] = [];
  private pendingCandidates: SignalData[] = [];
  private remoteDescriptionSet = false;
  private offerSent = false;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): CallState {
    return this.state;
  }

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private busy(): boolean {
    return this.state.phase !== 'idle' && this.state.phase !== 'ended';
  }

  private async loadIceServers(fallback: IceServer[]): Promise<IceServer[]> {
    if (fallback.length > 0) return fallback;
    try {
      const result = await api.get<{ iceServers: IceServer[] }>(`${V1}/calls/ice-servers`);
      return result.iceServers;
    } catch {
      return [];
    }
  }

  /** Customer calls the captain of the active trip. */
  async startOutgoing(tripId: string, peerName: string | null): Promise<void> {
    if (this.busy()) return;
    this.clearTimers();
    this.set({ ...IDLE, phase: 'outgoing', tripId, peerName, direction: 'outgoing', message: 'جارِ الاتصال…' });
    const ack = await emitAck<{ callId?: string; iceServers?: IceServer[]; ringTimeoutS?: number }>('call:invite', { tripId });
    if (!ack.ok || !ack.callId) {
      this.finish(ack.message ?? 'تعذّر بدء المكالمة');
      return;
    }
    this.iceServers = await this.loadIceServers(ack.iceServers ?? []);
    this.set({ callId: ack.callId, message: 'يرن…' });
    this.ringTimer = setTimeout(() => {
      if (this.state.phase === 'outgoing') void this.hangUp('TIMEOUT');
    }, (ack.ringTimeoutS ?? 45) * 1000);
  }

  handleIncoming(payload: IncomingCallPayload): boolean {
    if (this.busy()) {
      void emitAck('call:decline', { callId: payload.callId });
      return false;
    }
    this.clearTimers();
    this.iceServers = payload.iceServers ?? [];
    this.pendingSignals = [];
    this.set({
      ...IDLE,
      phase: 'incoming',
      callId: payload.callId,
      tripId: payload.tripId,
      peerName: payload.fromName,
      direction: 'incoming',
      message: 'مكالمة واردة عبر رايد',
    });
    return true;
  }

  async accept(): Promise<void> {
    const { callId } = this.state;
    if (this.state.phase !== 'incoming' || !callId) return;
    this.set({ phase: 'connecting', message: 'جارِ الاتصال…' });
    const ack = await emitAck<{ iceServers?: IceServer[] }>('call:accept', { callId });
    if (!ack.ok) {
      this.finish(ack.message ?? 'المكالمة لم تعد متاحة');
      return;
    }
    this.iceServers = await this.loadIceServers(ack.iceServers ?? this.iceServers);
    const ready = await this.createPeer();
    if (!ready) return;
    const buffered = this.pendingSignals;
    this.pendingSignals = [];
    for (const signal of buffered) await this.applySignal(signal);
  }

  async decline(): Promise<void> {
    const { callId } = this.state;
    if (callId) await emitAck('call:decline', { callId });
    this.finish('تم رفض المكالمة');
  }

  async hangUp(reason = 'HANGUP'): Promise<void> {
    const { callId } = this.state;
    if (callId) await emitAck('call:end', { callId, reason });
    this.finish(END_MESSAGES[reason] ?? END_MESSAGES.HANGUP ?? null);
  }

  toggleMute(): void {
    const muted = !this.state.muted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.set({ muted });
  }

  /** The captain answered our call: create and send the offer. */
  async handleAccepted(callId: string): Promise<void> {
    if (callId !== this.state.callId || this.state.phase !== 'outgoing') return;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.set({ phase: 'connecting', message: 'جارِ الاتصال…' });
    const ready = await this.createPeer();
    if (!ready || !this.peer) return;
    const buffered = this.pendingSignals;
    this.pendingSignals = [];
    for (const signal of buffered) await this.applySignal(signal);
    if (this.offerSent || this.remoteDescriptionSet) return;
    try {
      const offer = await this.peer.createOffer({});
      await this.peer.setLocalDescription(offer);
      this.offerSent = true;
      if (offer.sdp) await emitAck('call:signal', { callId, data: { type: 'offer', sdp: offer.sdp } });
    } catch {
      void this.hangUp('FAILED');
    }
  }

  handleDeclined(callId: string): void {
    if (callId === this.state.callId) this.finish(END_MESSAGES.DECLINED ?? null);
  }

  handleEnded(callId: string, reason: string | null): void {
    if (callId !== this.state.callId) return;
    this.finish((reason && END_MESSAGES[reason]) || END_MESSAGES.HANGUP || null);
  }

  async handleSignal(callId: string, data: SignalData): Promise<void> {
    if (callId !== this.state.callId) return;
    if (!this.peer) {
      this.pendingSignals.push(data);
      return;
    }
    await this.applySignal(data);
  }

  private async applySignal(data: SignalData): Promise<void> {
    const peer = this.peer;
    const callId = this.state.callId;
    if (!peer || !callId) return;
    try {
      if (data.type === 'offer') {
        await peer.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (answer.sdp) await emitAck('call:signal', { callId, data: { type: 'answer', sdp: answer.sdp } });
      } else if (data.type === 'answer') {
        await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
      } else if (!this.remoteDescriptionSet) {
        this.pendingCandidates.push(data);
      } else {
        await peer.addIceCandidate(
          new RTCIceCandidate({
            candidate: data.candidate.candidate,
            sdpMid: data.candidate.sdpMid ?? null,
            sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
          })
        );
      }
    } catch {
      // A bad candidate should not end the call; a bad SDP ends it through connection state.
    }
  }

  private async flushCandidates(): Promise<void> {
    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of candidates) await this.applySignal(candidate);
  }

  private async createPeer(): Promise<boolean> {
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      this.stream = stream;
      const peer = new RTCPeerConnection({ iceServers: this.iceServers });
      this.peer = peer;
      this.remoteDescriptionSet = false;
      this.offerSent = false;
      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
      });
      peer.addEventListener('icecandidate', (event) => {
        const candidate = event.candidate;
        const callId = this.state.callId;
        if (!candidate || !callId) return;
        void emitAck('call:signal', {
          callId,
          data: {
            type: 'candidate',
            candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null },
          },
        });
      });
      peer.addEventListener('connectionstatechange', () => {
        const connection = peer.connectionState;
        if (connection === 'connected' && this.state.phase !== 'active') {
          this.set({ phase: 'active', connectedAt: Date.now(), message: null });
        } else if (connection === 'failed') {
          void this.hangUp('FAILED');
        }
      });
      return true;
    } catch {
      this.finish('اسمح باستخدام الميكروفون لإجراء المكالمات');
      const { callId } = this.state;
      if (callId) void emitAck('call:end', { callId, reason: 'FAILED' });
      return false;
    }
  }

  private clearTimers() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.ringTimer = null;
    this.resetTimer = null;
  }

  private finish(message: string | null) {
    this.clearTimers();
    try {
      this.peer?.close();
    } catch {
      // closed
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    try {
      this.stream?.release();
    } catch {
      // released
    }
    this.peer = null;
    this.stream = null;
    this.pendingSignals = [];
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    this.offerSent = false;
    if (this.state.phase === 'idle') return;
    this.set({ phase: 'ended', message });
    this.resetTimer = setTimeout(() => this.set(IDLE), 1800);
  }
}

export const callManager = new CallManager();
export type { SignalData };
