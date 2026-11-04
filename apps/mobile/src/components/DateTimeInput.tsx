import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Platform } from 'react-native';

/** Android: the system date dialog then the time dialog. Returns false where an inline picker is used instead. */
export function openSystemDateTimePicker(start: Date, onPick: (d: Date) => void): boolean {
  if (Platform.OS !== 'android') return false;
  DateTimePickerAndroid.open({ value: start, mode: 'date', minimumDate: new Date(), onChange: (ev, date) => {
    if (ev.type !== 'set' || !date) return;
    DateTimePickerAndroid.open({ value: date, mode: 'time', onChange: (ev2, time) => {
      if (ev2.type === 'set' && time) onPick(time);
    } });
  } });
  return true;
}

export function DateTimeInput({ value, onChange }: { value: Date; onChange(d: Date): void }) {
  return <DateTimePicker value={value} mode="datetime" minimumDate={new Date()} onChange={(_e, d) => d && onChange(d)} />;
}
