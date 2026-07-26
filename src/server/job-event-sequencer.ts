/** Prevent a delayed database poll from overwriting a newer in-process event. */
export class MonotonicPollEpoch {
  private epoch = 0;

  beginPoll(): number {
    return this.epoch;
  }

  noteLocalEvent(): void {
    this.epoch += 1;
  }

  isCurrent(pollEpoch: number): boolean {
    return pollEpoch === this.epoch;
  }
}
