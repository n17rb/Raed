import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { emitWithAck, type ChatMessage } from '@rayed/api-client';
import { colors, radius } from '@rayed/design-system';
import { ErrorView, Icon, LoadingView, RText, ScreenHeader, font } from '@rayed/ui';
import { api, socket } from '../src/lib/api';
import { errorMessage, randomId, timeText } from '../src/lib/format';
import { useTrip } from '../src/state/trip';

type LocalMessage = ChatMessage & { pending?: boolean; failed?: boolean };

/** Customer ↔ captain chat: realtime, delivered/read ticks, typing indicator. */
export default function Chat() {
  const params = useLocalSearchParams<{ tripId: string }>();
  const tripId = params.tripId;
  const insets = useSafeAreaInsets();
  const { trip } = useTrip();
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<{ open: boolean; items: ChatMessage[] }>(`/api/v1/chats/${tripId}`);
      setMessages(result.items.slice().reverse());
      setOpen(result.open);
      void api.post(`/api/v1/chats/${tripId}/read`, {}).catch(() => undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onMessage = (message: ChatMessage) => {
      if (message.tripId !== tripId) return;
      setMessages((current) => (current.some((item) => item.id === message.id) ? current : [message, ...current]));
      setPeerTyping(false);
      void emitWithAck(socket, 'chat:read', { tripId });
    };
    const mark = (field: 'deliveredAt' | 'readAt') => (payload: { tripId: string; messageIds: string[]; deliveredAt?: string; readAt?: string }) => {
      if (payload.tripId !== tripId) return;
      const at = (field === 'readAt' ? payload.readAt : payload.deliveredAt) ?? new Date().toISOString();
      const ids = new Set(payload.messageIds);
      setMessages((current) =>
        current.map((item) =>
          ids.has(item.id) ? { ...item, [field]: at, deliveredAt: item.deliveredAt ?? at } : item
        )
      );
    };
    const onDelivered = mark('deliveredAt');
    const onRead = mark('readAt');
    const onTyping = (payload: { tripId: string; typing: boolean }) => {
      if (payload.tripId !== tripId) return;
      setPeerTyping(payload.typing);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (payload.typing) typingTimer.current = setTimeout(() => setPeerTyping(false), 5000);
    };
    socket.on('chat:message', onMessage);
    socket.on('chat:delivered', onDelivered);
    socket.on('chat:read', onRead);
    socket.on('chat:typing', onTyping);
    socket.on('connect', load);
    return () => {
      socket.off('chat:message', onMessage);
      socket.off('chat:delivered', onDelivered);
      socket.off('chat:read', onRead);
      socket.off('chat:typing', onTyping);
      socket.off('connect', load);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [load, tripId]);

  const send = async (body: string, clientMessageId = randomId()) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const optimistic: LocalMessage = {
      id: clientMessageId,
      tripId,
      senderId: 'me',
      mine: true,
      kind: 'TEXT',
      body: trimmed,
      clientMessageId,
      deliveredAt: null,
      readAt: null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((current) => [optimistic, ...current.filter((item) => item.clientMessageId !== clientMessageId)]);
    setText('');
    try {
      let saved: ChatMessage | null = null;
      if (socket.connected) {
        const ack = (await emitWithAck(socket, 'chat:send', { tripId, body: trimmed, clientMessageId })) as unknown as {
          ok: boolean;
          message?: ChatMessage | string;
        };
        if (ack.ok && ack.message && typeof ack.message === 'object') saved = ack.message;
      }
      if (!saved) {
        // REST fallback; the server ignores duplicates with the same clientMessageId.
        const result = await api.post<{ message: ChatMessage }>(`/api/v1/chats/${tripId}/messages`, { body: trimmed, clientMessageId });
        saved = result.message;
      }
      const message = saved;
      setMessages((current) => current.map((item) => (item.clientMessageId === clientMessageId ? message : item)));
    } catch {
      setMessages((current) => current.map((item) => (item.clientMessageId === clientMessageId ? { ...item, pending: false, failed: true } : item)));
    }
  };

  const onChangeText = (value: string) => {
    setText(value);
    const now = Date.now();
    if (now - lastTypingSent.current > 2500 && value.length > 0) {
      lastTypingSent.current = now;
      socket.emit('chat:typing', { tripId, typing: true });
    }
  };

  const title = trip?.captain?.name ?? 'الكابتن';

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title={title} onBack={() => router.back()} />
      {peerTyping ? (
        <RText variant="caption" color={colors.primary} align="center" style={styles.typing}>
          يكتب الآن…
        </RText>
      ) : null}
      {loading && messages.length === 0 ? (
        <LoadingView />
      ) : error && messages.length === 0 ? (
        <ErrorView message={error} onRetry={() => void load()} />
      ) : (
        <FlatList
          inverted
          data={messages}
          keyExtractor={(item) => item.clientMessageId || item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              disabled={!item.failed}
              onPress={() => item.body && void send(item.body, item.clientMessageId)}
              style={[styles.bubbleRow, item.mine ? styles.mineRow : styles.theirRow]}
            >
              <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}>
                <RText variant="bodyRegular" color={item.mine ? colors.textOnPrimary : colors.textPrimary}>
                  {item.body ?? ''}
                </RText>
                <View style={styles.meta}>
                  <RText variant="micro" color={item.mine ? 'rgba(255,255,255,0.8)' : colors.textSecondary}>
                    {timeText(item.createdAt)}
                  </RText>
                  {item.mine ? (
                    item.failed ? (
                      <RText variant="micro" color={colors.dangerSoft}>
                        لم تُرسل · اضغط لإعادة المحاولة
                      </RText>
                    ) : item.pending ? (
                      <Icon name="clock" size={11} color="rgba(255,255,255,0.8)" />
                    ) : (
                      <View style={styles.ticks}>
                        <Icon name="check" size={12} color={item.readAt ? colors.textOnPrimary : 'rgba(255,255,255,0.7)'} strokeWidth={2} />
                        {item.deliveredAt ? (
                          <View style={styles.secondTick}>
                            <Icon name="check" size={12} color={item.readAt ? colors.textOnPrimary : 'rgba(255,255,255,0.7)'} strokeWidth={2} />
                          </View>
                        ) : null}
                      </View>
                    )
                  ) : null}
                </View>
              </View>
            </Pressable>
          )}
          ListEmptyComponent={
            <RText variant="bodyRegular" color={colors.textSecondary} align="center" style={styles.empty}>
              ابدأ المحادثة مع الكابتن
            </RText>
          }
        />
      )}
      {open ? (
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <TextInput
            value={text}
            onChangeText={onChangeText}
            placeholder="اكتب رسالة"
            placeholderTextColor={colors.textTertiary}
            multiline
            maxLength={1000}
            style={[styles.input, font('input'), { color: colors.textPrimary }]}
          />
          <Pressable onPress={() => void send(text)} disabled={!text.trim()} style={[styles.send, !text.trim() ? styles.sendDisabled : null]} accessibilityLabel="إرسال">
            <Icon name="send" size={20} color={colors.textOnPrimary} />
          </Pressable>
        </View>
      ) : (
        <RText variant="caption" color={colors.textSecondary} align="center" style={[styles.closed, { paddingBottom: insets.bottom + 12 }]}>
          انتهت المحادثة بانتهاء الرحلة
        </RText>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.screenTintLight },
  typing: { paddingBottom: 4 },
  list: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  bubbleRow: { flexDirection: 'row' },
  mineRow: { justifyContent: 'flex-end' },
  theirRow: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '80%', borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 9, gap: 4 },
  mine: { backgroundColor: colors.primary, borderBottomRightRadius: 6 },
  theirs: { backgroundColor: colors.surface, borderBottomLeftRadius: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end' },
  ticks: { flexDirection: 'row' },
  secondTick: { marginLeft: -7 },
  empty: { marginTop: 40, transform: [{ scaleY: -1 }] },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    borderRadius: radius.xl,
    backgroundColor: colors.searchField,
    paddingHorizontal: 14,
    paddingVertical: 10,
    textAlign: 'right',
  },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.5 },
  closed: { paddingTop: 12 },
});
