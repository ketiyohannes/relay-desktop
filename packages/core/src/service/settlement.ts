/** A timeout is uncertainty, never proof that a runtime stopped acting. */
export class SettlementTimeout extends Error {}

export async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new SettlementTimeout("Runtime settlement timed out; inspect execution")),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Normal turns have no deadline. Cancellation starts a bounded settlement grace period. */
export async function untilCancelled<T>(operation: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expire!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		expire = () => {
			timer = setTimeout(
				() => reject(new SettlementTimeout("Cancelled runtime did not settle; ownership retained")),
				milliseconds,
			);
		};
		signal.addEventListener("abort", expire, { once: true });
		if (signal.aborted) expire();
	});
	try {
		return await Promise.race([operation, cancelled]);
	} finally {
		signal.removeEventListener("abort", expire);
		clearTimeout(timer);
	}
}
