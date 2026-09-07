/** S16 §13.2 — bounded-cardinality counters; registered with the S15 metrics registry when it lands (docs/TODO.md). */
export interface TasksMetrics {
  handleReturned(kind: string): void;
  methodCall(
    method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    outcome: 'ok' | 'protocol_error',
  ): void;
  terminalProjected(state: string): void;
  cancelRequested(outcome: 'accepted' | 'refused' | 'undelivered'): void;
  cancelRefusedIrreversible(): void;
  timeToTerminal(kind: string, seconds: number): void;
}

export const noopTasksMetrics: TasksMetrics = {
  handleReturned() {},
  methodCall() {},
  terminalProjected() {},
  cancelRequested() {},
  cancelRefusedIrreversible() {},
  timeToTerminal() {},
};
