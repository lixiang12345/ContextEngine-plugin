import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MonotonicPollEpoch } from "../src/server/job-event-sequencer.js";

describe("job event poll sequencing", () => {
  it("discards a database poll that started before a newer local event", () => {
    const sequence = new MonotonicPollEpoch();
    const delayedPoll = sequence.beginPoll();
    assert.equal(sequence.isCurrent(delayedPoll), true);

    sequence.noteLocalEvent();
    assert.equal(sequence.isCurrent(delayedPoll), false);
    assert.equal(sequence.isCurrent(sequence.beginPoll()), true);
  });
});
