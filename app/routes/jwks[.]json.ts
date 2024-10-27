import type { HeadersFunction } from "@vercel/remix";
import { createOAuthClient } from "~/server/oauth/client";

export const headers: HeadersFunction = () => ({
	"Content-Type": "application/json",
	"Cache-Control": "public, max-age=3600",
});

export const loader = async () => {
	const oauthClient = await createOAuthClient();
	return oauthClient.jwks;
};
