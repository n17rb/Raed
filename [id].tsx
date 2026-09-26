import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { emitWithAck, type SupportMessage, type SupportTicket } from '@rayed/api-client';
import { colors, radius } from '@rayed/design-system';
import { ErrorView, Icon, LoadingView, RText, font } from '@rayed/ui';
import { api, socket } from '../../src/lib/api';
import { errorMessage, randomId, timeText } from '../../src/lib/format';
import { Page } from '../../src/components/Page';

type LocalMessage = SupportMessage & { pending?: boolean; failed?: boolean };

/** Realtime conversation with the Rayed support team. Messages are saved on the server. */
export default function SupportTicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [adminTyping, setAdminTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTyping = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ ticket: SupportTicket; messages: SupportMessage[] }>(`/api/v1/support/tickets/${id}`);
      setTicket(result.ticket);
      setMessages(result.messages.slice().reverse());
      setError(null);
      void emitWithAck(socket, 'ticket:subscribe', { ticketId: id });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onMessage = (message: SupportMessage) => {
      if (message.ticketId !== id) return;
      setMessages((current) =>
        current.some((item) => item.id === message.id || item.clientMessageId === message.clientMessageId)
          ? current.map((item) => (item.clientMessageId === message.clientMessageId ? message : item))
          : [message, ...current]
      );
      if (message.senderRole === 'ADMIN') setAdminTyping(false);
    };
    const onTyping = (payload: { ticketId: string; typing: boolean }) => {
      if (payload.ticketId !== id) return;
      setAdminTyping(payload.typing);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (payload.typing) typingTimer.current = setTimeout(() => setAdminTyping(false), 5000);
    };
    const onStatus = (payload: { ticketId: string; status: SupportTicket['status'] }) => {
      if (payload.ticketId === id) setTicket((current) => (current ? { ...current, status: payload.status } : current));
    };
    socket.on('support:message', onMessage);
    socket.on('support:typing', onTyping);
    socket.on('support:status', onStatus);
    socket.on('connect', load);
    return () => {
      socket.off('support:message', onMessage);
      socket.off('support:typing', onTyping);
      socket.off('support:status', onStatus);
      socket.off('connect', load);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [id, load]);

  const send = async (body: string, clientMessageId = randomId()) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const optimistic: LocalMessage = {
      id: clientMessageId,
      ticketId: id,
      senderId: null,
      senderRole: 'USER',
      body: trimmed,
      clientMessageId,
      readAt: null,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((current) => [optimistic, ...current.filter((item) => item.clientMessageId !== clientMessageId)]);
    setText('');
    try {
      const result = await api.post<{ message: SupportMessage }>(`/api/v1/support/tickets/${id}/messages`, { body: trimmed, clientMessageId });
      setMessages((current) => current.map((item) => (item.clientMessageId === clientMessageId ? result.message : item)));
    } catch {
      setMessages((current) => current.map((item) => (item.clientMessageId === clientMessageId ? { ...item, pending: false, failed: true } : item)));
    }
  };

  const onChangeText = (value: string) => {
    setText(value);
    const now = Date.now();
    if (value && now - lastTyping.current > 2500) {
      lastTyping.current = now;
      socket.emit('support:typing', { ticketId: id, typing: true });
    }
  };

  const closed = ticket?.status === 'CLOSED';

  return (
    <Page title={ticket?.subject ?? 'مركز المساعدة'}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        {loading ? (
          <LoadingView />
        ) : error && !ticket ? (
          <ErrorView message={error} onRetry={() => void load()} />
        ) : (
          <FlatList
            inverted
            data={messages}
            keyExtractor={(item) => item.clientMessageId || item.id}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              adminTyping ? (
                <RText variant="caption" color={colors.primary} style={styles.typing}>
                  فريق الدعم يكتب الآن…
                </RText>
              ) : null
            }
            renderItem={({ item }) => {
              const mine = item.senderRole === 'USER';
              if (item.senderRole === 'SYSTEM') {
                return (
                  <RText variant="caption" color={colors.textSecondary} align="center" style={styles.system}>
                    {item.body ?? ''}
                  </RText>
                );
              }
              return (
                <Pressable
                  disabled={!item.failed}
                  onPress={() => item.body && void send(item.body, item.clientMessageId)}
                  style={[styles.row, mine ? styles.mineRow : styles.theirRow]}
                >
                  <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                    {!mine ? (
                      <RText variant="micro" color={colors.primary}>
                        فريق رايد
                      </RText>
                    ) : null}
                    <RText variant="bodyRegular" color={mine ? colors.textOnPrimary : colors.textPrimary}>
                      {item.body ?? ''}
                    </RText>
                    <RText variant="micro" color={mine ? 'rgba(255,255,255,0.8)' : colors.textSecondary} align="left">
                      {item.failed ? 'لم تُرسل · اضغط لإعادة المحاولة' : item.pending ? 'جارٍ الإرسال…' : timeText(item.createdAt)}
                    </RText>
                  </View>
                </Pressable>
              );
            }}
          />
        )}
        {closed ? (
          <RText variant="caption" color={colors.textSecondary} align="center" style={[styles.closed, { paddingBottom: insets.bottom + 12 }]}>
            أُغلقت هذه المحادثة. يمكنك فتح محادثة جديدة من مركز المساعدة
          </RText>
        ) : (
          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <TextInput
              value={text}
              onChangeText={onChangeText}
              placeholder="اكتب رسالتك"
              placeholderTextColor={colors.textTertiary}
              multiline
              maxLength={2000}
              style={[styles.input, font('input'), { color: colors.textPrimary }]}
            />
            <Pressable onPress={() => void send(text)} disabled={!text.trim()} style={[styles.send, !text.trim() ? styles.sendDisabled : null]} accessibilityLabel="إرسال">
              <Icon name="send" size={20} color={colors.textOnPrimary} />
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </Page>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  typing: { marginBottom: 6 },
  system: { marginVertical: 6 },
  row: { flexDirection: 'row' },
  mineRow: { justifyContent: 'flex-end' },
  theirRow: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 9, gap: 3 },
  mine: { backgroundColor: colors.primary, borderBottomRightRadius: 6 },
  theirs: { backgroundColor: colors.surface, borderBottomLeftRadius: 6 },
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
