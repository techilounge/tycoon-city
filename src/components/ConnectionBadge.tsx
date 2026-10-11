import type { ConnectionState } from '@/lib/game/transport/onlineClient';

/**
 * Connection state indicator (spec "Client experience"): live, reconnecting,
 * or offline. Presentation only — the OnlineGameClient owns the truth.
 */

const BADGE: Record<ConnectionState, { label: string; dot: string; ring: string }> = {
  connecting: { label: 'Connecting…', dot: 'bg-[#eacb7b]', ring: 'border-[#eacb7b]/60' },
  live: { label: 'Live', dot: 'bg-[#7fa8a4]', ring: 'border-[#7fa8a4]/60' },
  reconnecting: { label: 'Reconnecting…', dot: 'bg-[#e8a87c]', ring: 'border-[#e8a87c]/60' },
  offline: { label: 'Offline', dot: 'bg-[#b45d5d]', ring: 'border-[#b45d5d]/60' },
};

export function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  const style = BADGE[connection];
  const pulsing = connection === 'connecting' || connection === 'reconnecting';
  return (
    <span
      role="status"
      aria-label={`Connection: ${style.label}`}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold text-slate-200 ${style.ring}`}
    >
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${style.dot} ${pulsing ? 'animate-pulse' : ''}`} />
      {style.label}
    </span>
  );
}
