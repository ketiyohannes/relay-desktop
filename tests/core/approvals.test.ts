import assert from "node:assert/strict";
import { test } from "node:test";
import type { Approval } from "../../src/core/contracts.ts";
import { ApprovalPresenter } from "../../src/core/desktop/approvals.ts";

test("snapshot approval recovery is independent of cursor and closes on external settlement", async () => {
	let presentations = 0;
	let signal: AbortSignal | undefined;
	let decide!: (allowed: boolean) => void;
	const responses: boolean[] = [];
	const presenter = new ApprovalPresenter(
		async (_approval, _session, nextSignal) => {
			presentations++;
			signal = nextSignal;
			return new Promise<boolean>((resolve) => {
				decide = resolve;
			});
		},
		async (_session, _id, allowed) => {
			responses.push(allowed);
		},
	);
	const approval: Approval = {
		id: "approval",
		nativeRecordId: "native",
		turnId: "turn",
		tool: "bash",
		input: {},
		expiresAt: Date.now() + 10000,
		status: "pending",
	};
	presenter.update("session", approval);
	presenter.update("session", approval);
	assert.equal(presentations, 1);
	presenter.update("session", { ...approval, status: "denied" });
	assert.equal(signal?.aborted, true);
	decide(true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(responses, []);
	presenter.close();
});
