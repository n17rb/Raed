import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Linking, Modal, Pressable, StyleSheet, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@rayed/design-system';
import { Avatar, Icon, RText, type IconName } from '@rayed/ui';
import { api, socket } from '../lib/api';
import { errorMessage } from '../lib/format';
import { useSession } from '../state/session';
import { callManager, type CallState, type IncomingCallPayload, type SignalData } from './calls';

interface CallContextValue {
  call: CallState;
  internetCallsEnabled: boolean;
  callInternet: (tripId: string, peerName: string | null) => void;
  callPhone: (tripId: string) => Promise<void>;
}

const CallContext = createContext<CallContextValue | null>(null);

function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { config } = useSession();
  const [call, setCall] = useState<CallState>(callManager.getState());
  const internetCallsEnabled = config?.features.internetCalls ?? true;

  useEffect(() => callManager.subscribe(setCall), []);

  // Vibrate while an incoming call is ringing.
  useEffect(() => {
    if (call.phase === 'incoming') Vibration.vibrate([0, 700, 500], true);
    else Vibration.cancel();
    return () => Vibration.cancel();
  }, [call.phase]);

  useEffect(() => {
    const onIncoming = (payload: IncomingCallPayload) => callManager.handleIncoming(payload);
    const onAccepted = (payload: { callId: string }) => void callManager.handleAccepted(payload.callId);
    const onDeclined = (payload: { callId: string }) => callManager.handleDeclined(payload.callId);
    const onEnded = (payload: { callId: string; reason: string | null }) => callManager.handleEnded(payload.callId, payload.reason);
    const onSignal = (payload: { callId: string; data: SignalData }) => void callManager.handleSignal(payload.callId, payload.data);
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:declined', onDeclined);
    socket.on('call:ended', onEnded);
    socket.on('call:signal', onSignal);
    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('call:declined', onDeclined);
      socket.off('call:ended', onEnded);
      socket.off('call:signal', onSignal);
    };
  }, []);

  const callInternet = useCallback((tripId: string, peerName: string | null) => {
    void callManager.startOutgoing(tripId, peerName);
  }, []);

  const callPhone = useCallback(async (tripId: string) => {
    try {
      const result = await api.post<{ phone: string }>('/api/v1/calls/phone', { tripId });
      await Linking.openURL(`tel:${result.phone}`);
    } catch (error) {
      Alert.alert('تعذّر الاتصال', errorMessage(error));
    }
  }, []);

  const value = useMemo(() => ({ call, internetCallsEnabled, callInternet, callPhone }), [call, internetCallsEnabled, callInternet, callPhone]);

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallOverlay
        call={call}
        onAccept={() => void callManager.accept()}
        onDecline={() => void callManager.decline()}
        onHangUp={() => void callManager.hangUp()}
        onToggleMute={() => callManager.toggleMute()}
      />
    </CallContext.Provider>
  );
}

export function useCalls(): CallContextValue {
  const value = useContext(CallContext);
  if (!value) throw new Error('useCalls must be used inside CallProvider');
  return value;
}

function CallOverlay({
  call,
  onAccept,
  onDecline,
  onHangUp,
  onToggleMute,
}: {
  call: CallState;
  onAccept: () => void;
  onDecline: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (call.phase !== 'active') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.phase]);

  const peer = call.peerName ?? 'الكابتن';
  const status = call.phase === 'active' && call.connectedAt ? clockLabel((now - call.connectedAt) / 1000) : call.message ?? '';

  return (
    <Modal
      visible={call.phase !== 'idle'}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={call.phase === 'incoming' ? onDecline : onHangUp}
    >
      <SafeAreaView style={styles.screen}>
        <View style={styles.top}>
          <RText variant="caption" color={colors.textSecondary} align="center">
            مكالمة عبر الإنترنت · رايد
          </RText>
          <View style={styles.avatarRing}>
            <Avatar name={peer} size={96} />
          </View>
          <RText variant="screenTitle" align="center">
            {peer}
          </RText>
          <RText variant="body" color={call.phase === 'ended' ? colors.danger : colors.textSecondary} align="center">
            {status}
          </RText>
        </View>
        <View style={styles.actions}>
          {call.phase === 'incoming' ? (
            <>
              <RoundAction icon="phoneOff" label="رفض" background={colors.danger} onPress={onDecline} />
              <RoundAction icon="phone" label="رد" background={colors.success} onPress={onAccept} />
            </>
          ) : call.phase === 'ended' ? null : (
            <>
              <RoundAction
                icon={call.muted ? 'micOff' : 'mic'}
                label={call.muted ? 'إلغاء الكتم' : 'كتم'}
                background={call.muted ? colors.navy : colors.actionCircle}
                iconColor={call.muted ? colors.textOnPrimary : colors.navy}
                onPress={onToggleMute}
                disabled={call.phase !== 'active'}
              />
              <RoundAction icon="phoneOff" label="إنهاء" background={colors.danger} onPress={onHangUp} />
            </>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function RoundAction({
  icon,
  label,
  background,
  iconColor = colors.textOnPrimary,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  background: string;
  iconColor?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.action}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={disabled ? undefined : onPress}
        style={({ pressed }) => [styles.round, { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}
      >
        <Icon name={icon} size={30} color={iconColor} />
      </Pressable>
      <RText variant="caption" color={colors.textSecondary} align="center">
        {label}
      </RText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.screenTint, justifyContent: 'space-between', paddingVertical: spacing.huge },
  top: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.huge },
  avatarRing: { padding: spacing.md, borderRadius: radius.pill, backgroundColor: colors.primarySoft, marginVertical: spacing.lg },
  actions: { flexDirection: 'row', justifyContent: 'space-evenly', paddingBottom: spacing.huge },
  action: { alignItems: 'center', gap: spacing.sm },
  round: { width: 72, height: 72, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
});
