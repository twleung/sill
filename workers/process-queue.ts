import { db } from "~/drizzle/db.server";
import { dequeueJobs, enqueueJob } from "~/utils/queue.server";
import {
	fetchLinks,
	insertNewLinks,
	type ProcessedResult,
} from "~/utils/links.server";
import { accountUpdateQueue, user } from "~/drizzle/schema.server";
import { asc, eq, sql } from "drizzle-orm";

async function processQueue() {
	const BATCH_SIZE = Number.parseInt(process.env.UPDATE_BATCH_SIZE || "100");

	while (true) {
		const batchStart = Date.now();
		const jobs = await dequeueJobs(BATCH_SIZE);

		if (jobs.length > 0) {
			console.log(`[Queue] Processing batch of ${jobs.length} jobs`);
			const allLinks: ProcessedResult[] = [];
			const results = await Promise.all(
				jobs.map(async (job) => {
					const jobStart = Date.now();
					try {
						const timeoutPromise = new Promise((_, reject) => {
							const timer = setTimeout(() => {
								reject(new Error("Job timed out after 120 seconds"));
							}, 120000);
							// Clear timer when promise resolves
							return () => clearTimeout(timer);
						});
						const jobPromise = (async () => {
							const links = await fetchLinks(job.userId);
							allLinks.push(...links);

							await db
								.update(accountUpdateQueue)
								.set({
									status: "completed",
									processedAt: new Date(),
								})
								.where(eq(accountUpdateQueue.id, job.id));
						})();

						await Promise.race([timeoutPromise, jobPromise]);
						return { status: "success", duration: Date.now() - jobStart };
					} catch (error) {
						console.log(`Error for user ${job.userId}: ${error}`);

						await db
							.update(accountUpdateQueue)
							.set({
								status: "failed",
								error: String(error),
								retries: sql`${accountUpdateQueue.retries} + 1`,
							})
							.where(eq(accountUpdateQueue.id, job.id));

						return { status: "error", error, duration: Date.now() - jobStart };
					}
				}),
			);

			await insertNewLinks(allLinks);
			const batchDuration = Date.now() - batchStart;

			console.log(`[Queue] Batch complete:
      Processed: ${jobs.length}
      Success: ${results.filter((r) => r.status === "success").length}
      Errors: ${results.filter((r) => r.status === "error").length}
      Batch Duration: ${batchDuration}ms
      Avg Job Duration: ${batchDuration / jobs.length}ms
    `);
		} else {
			if (process.env.NODE_ENV === "production") {
				const users = await db.query.user.findMany({
					orderBy: asc(user.createdAt),
				});

				await Promise.all(users.map((user) => enqueueJob(user.id)));
				console.log(`[Queue] No jobs found, enqueued ${users.length} users`);
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	processQueue().catch(console.error);
}
