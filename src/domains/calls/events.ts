export type ProviderEvent = {
  provider: 'elevenlabs' | 'twilio';
  providerEventId: string;
  eventType: string;
  conversationId?: string | undefined;
  callSid?: string | undefined;
  callSessionId?: string | undefined;
  status: string;
  failureMessage?: string | undefined;
  durationSeconds?: number | undefined;
  payload: Record<string, unknown>;
  occurredAt: string;
};

const ranks: Record<string, number> = {
  created: 0,
  initiating: 1,
  initiated: 2,
  ringing: 3,
  in_progress: 4,
  completed: 5,
  busy: 6,
  no_answer: 6,
  failed: 6,
  cancelled: 6,
};

// Failure dominates a transport-level completion; delayed progress cannot revive a call.
export function nextCallStatus(current: string, incoming: string): string {
  return (ranks[incoming] ?? -1) > (ranks[current] ?? -1) ? incoming : current;
}

export function isTerminal(status: string): boolean {
  return (ranks[status] ?? 0) >= 5;
}
