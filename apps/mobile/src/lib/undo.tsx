import type { OutboundDto } from '@app/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from './api';

interface UndoApi {
  /** Shows the "Sending… Undo" bar for a just-queued message until its undo window ends. */
  offer(o: OutboundDto): void;
}
const Ctx = createContext<UndoApi>({ offer: () => undefined });
export const useUndo = () => useContext(Ctx);

export function UndoProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<OutboundDto | null>(null);
  const [left, setLeft] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const offer = useCallback((o: OutboundDto) => { setResult(null); setCurrent(o); }, []);

  useEffect(() => {
    if (!current?.releaseAt) return;
    const tick = () => {
      const s = Math.ceil((new Date(current.releaseAt!).getTime() - Date.now()) / 1000);
      setLeft(s);
      if (s <= 0) { setCurrent(null); setResult('Sending to the mail server…'); setTimeout(() => setResult(null), 3000); }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [current]);

  const bar = current || result;
  return (
    <Ctx.Provider value={{ offer }}>
      {children}
      {bar ? (
        <View accessibilityLiveRegion="polite" style={{ position: 'absolute', left: 12, right: 12, bottom: insets.bottom + 12, backgroundColor: '#1f2933',
          borderRadius: 10, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: '#fff', flex: 1 }}>{current ? `Sending in ${Math.max(0, left)} s…` : result}</Text>
          {current ? (
            <Pressable accessibilityRole="button" onPress={async () => {
              const o = current;
              setCurrent(null);
              try { await api.undoSend(o.id); setResult('Cancelled. Nothing was sent.'); }
              catch (e) { setResult((e as Error).message); }
              setTimeout(() => setResult(null), 4000);
            }}>
              <Text style={{ color: '#93c5fd', fontWeight: '700', fontSize: 16 }}>UNDO</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Ctx.Provider>
  );
}
