import { createElement } from 'react';
import { useTheme } from './ui';

export function openSystemDateTimePicker(_start: Date, _onPick: (d: Date) => void): boolean {
  return false; // the browser's own picker is shown inline
}

const local = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function DateTimeInput({ value, onChange }: { value: Date; onChange(d: Date): void }) {
  const t = useTheme();
  return createElement('input', {
    type: 'datetime-local', value: local(value), min: local(new Date()), 'aria-label': 'Send at',
    onChange: (e: { target: { value: string } }) => { const d = new Date(e.target.value); if (!Number.isNaN(d.getTime())) onChange(d); },
    style: { fontSize: 16, padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, background: t.surface, color: t.text, marginBottom: 12 },
  });
}
