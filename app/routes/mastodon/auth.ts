import type { Route } from "./+types/auth";
import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7-js";
import { db } from "~/drizzle/db.server";
import { mastodonInstance } from "~/drizzle/schema.server";
import { getAuthorizationUrl } from "~/utils/mastodon.server";
import { createInstanceCookie } from "~/utils/session.server";

export const loader = async ({ request }: Route.LoaderArgs) => {
	const requestUrl = new URL(request.url);
	let instance = requestUrl.searchParams.get("instance");

	if (!instance) {
		return null;
	}

	// If someone entered their full handle, get the instance from it
	instance = instance.toLocaleLowerCase().trim();

	if (instance.includes("https://")) {
		instance = instance.replace("https://", "");
	}

	if (instance.includes("/")) {
		instance = instance.split("/")[0];
	}

	if (instance.includes("@")) {
		instance = instance.split("@").at(-1) as string;
	}

	if (!instance.includes(".")) {
		return redirect("/connect?error=instance");
	}

	let instanceData = await db.query.mastodonInstance.findFirst({
		where: eq(mastodonInstance.instance, instance),
	});
	if (!instanceData) {
		try {
			const response = await fetch(`https://${instance}/api/v1/apps`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					client_name: "Sill",
					redirect_uris: process.env.MASTODON_REDIRECT_URI,
					scopes: "read",
				}),
			});
			const data = await response.json();

			const insert = await db
				.insert(mastodonInstance)
				.values({
					id: uuidv7(),
					instance: instance,
					clientId: data.client_id,
					clientSecret: data.client_secret,
				})
				.returning({
					id: mastodonInstance.id,
					instance: mastodonInstance.instance,
					clientId: mastodonInstance.clientId,
					clientSecret: mastodonInstance.clientSecret,
					createdAt: mastodonInstance.createdAt,
				});

			instanceData = insert[0];
		} catch (error) {
			console.error(error);
			return redirect("/connect?error=instance");
		}
	}

	const authorizationUrl = getAuthorizationUrl(instance, instanceData.clientId);
	return await createInstanceCookie(request, instance, authorizationUrl);
};
