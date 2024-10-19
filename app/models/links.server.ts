import {
	AppBskyFeedDefs,
	Agent,
	AppBskyFeedPost,
	AppBskyEmbedRecord,
	AppBskyEmbedExternal,
	AppBskyEmbedImages,
	AppBskyRichtextFacet,
	type AppBskyActorDefs,
	RichText,
} from "@atproto/api";
import {
	OAuthResponseError,
	type OAuthSession,
} from "@atproto/oauth-client-node";
import { createRestAPIClient, type mastodon } from "masto";
import { uuidv7 } from "uuidv7-js";
import { PostType } from "@prisma/client";
import groupBy from "object.groupby";
import { Prisma } from "@prisma/client";
import { extractFromUrl } from "@jcottam/html-metadata";
import { createOAuthClient } from "~/server/oauth/client";
import { prisma } from "~/db.server";
import { linksQueue } from "~/queue.server";
import TimeAgo from "javascript-time-ago";
import en from "javascript-time-ago/locale/en";

TimeAgo.addDefaultLocale(en);
const timeAgo = new TimeAgo("en-US");

interface BskyDetectedLink {
	uri: string;
	title: string | null;
	description: string | null;
	imageUrl?: string | null;
}

const ONE_DAY_MS = 86400000; // 24 hours in milliseconds

const fetchRebloggedPosts = async (
	client: mastodon.rest.Client,
	status: mastodon.v1.Status,
) => {
	const rebloggedPosts: mastodon.v1.Status[] = [];
	for await (const rebloggerGroup of client.v1.statuses
		.$select(status.id)
		.rebloggedBy.list()) {
		for await (const reblogger of rebloggerGroup) {
			for await (const rebloggerStatuses of client.v1.accounts
				.$select(reblogger.id)
				.statuses.list()) {
				let foundStatus = false;
				for await (const rebloggerStatus of rebloggerStatuses) {
					if (rebloggerStatus.reblog?.id === status.id) {
						rebloggedPosts.push(rebloggerStatus);
						foundStatus = true;
						break;
					}
				}
				if (foundStatus) {
					break;
				}
			}
		}
	}

	return rebloggedPosts;
};

export const getMastodonTimeline = async (userId: string) => {
	const yesterday = new Date(Date.now() - ONE_DAY_MS);

	const account = await prisma.mastodonAccount.findFirst({
		where: {
			userId: userId,
		},
	});

	if (!account) return [];

	const client = createRestAPIClient({
		url: account.instance,
		accessToken: account.accessToken,
	});

	const timeline: mastodon.v1.Status[] = [];
	let ended = false;
	for await (const statuses of client.v1.timelines.home.list({
		sinceId: account.mostRecentPostId,
	})) {
		if (ended) break;
		for await (const status of statuses) {
			if (new Date(status.createdAt) <= yesterday) {
				ended = true;
				break;
			}
			if (status.id === account.mostRecentPostId) {
				ended = true;
				break;
			}

			// NASTY. Mastodon doesn't return reblogs if you follow the original poster.
			// We need those reblogs. So we have to find the rebloggers and search their
			// timelines for the reblog post.
			if (status.reblogsCount > 0) {
				const rebloggedPosts = await fetchRebloggedPosts(client, status);
				timeline.push(...rebloggedPosts);
			}
			timeline.push(status);
		}
	}

	if (timeline.length > 0) {
		await prisma.mastodonAccount.update({
			where: {
				id: account.id,
			},
			data: {
				mostRecentPostId: timeline[0].id,
			},
		});
	}

	return timeline;
};

const handleBlueskyOAuth = async (account: { did: string }) => {
	let oauthSession: OAuthSession | null = null;
	try {
		const client = await createOAuthClient();
		oauthSession = await client.restore(account.did);
	} catch (error) {
		if (error instanceof OAuthResponseError) {
			const client = await createOAuthClient();
			oauthSession = await client.restore(account.did);
		}
	}
	return oauthSession;
};

export const getBlueskyTimeline = async (userId: string) => {
	const account = await prisma.blueskyAccount.findFirst({
		where: {
			userId: userId,
		},
	});
	if (!account) return [];

	const oauthSession = await handleBlueskyOAuth(account);
	if (!oauthSession) return [];

	const agent = new Agent(oauthSession);

	async function getTimeline(cursor: string | undefined = undefined) {
		const response = await agent.getTimeline({
			limit: 100,
			cursor,
		});
		const timeline = response.data.feed;
		const checkDate =
			account?.mostRecentPostDate || new Date(Date.now() - ONE_DAY_MS); // 24 hours ago

		let reachedEnd = false;
		let newPosts = timeline.filter((item) => {
			const postDate = AppBskyFeedDefs.isReasonRepost(item.reason)
				? new Date(item.reason.indexedAt)
				: new Date(item.post.indexedAt);
			if (postDate <= checkDate) {
				reachedEnd = true;
			}
			return postDate > checkDate;
		});

		if (!reachedEnd) {
			newPosts = newPosts.concat(await getTimeline(response.data.cursor));
		}
		return newPosts;
	}

	const timeline = await getTimeline();

	if (timeline.length > 0) {
		const firstPost = timeline[0];
		const tokenSet = await oauthSession.getTokenSet();

		await prisma.blueskyAccount.update({
			where: {
				id: account.id,
			},
			data: {
				mostRecentPostDate: new Date(
					AppBskyFeedDefs.isReasonRepost(firstPost.reason)
						? firstPost.reason.indexedAt
						: firstPost.post.indexedAt,
				),
				accessJwt: tokenSet.access_token,
				refreshJwt: tokenSet.refresh_token,
			},
		});
	}
	return timeline;
};

const processMastodonLink = async (userId: string, t: mastodon.v1.Status) => {
	const original = t.reblog || t;
	const url = original.url;
	const card = original.card;

	if (!url || !card) {
		return null;
	}

	// Sometimes Mastodon returns broken cards for YouTube.
	// I know I shouldn't regex HTML, but here we are.
	if (original.card?.url === "https://www.youtube.com/undefined") {
		const regex =
			/(https:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+(?:<[^>]+>)*[\w-]+(?:\?(?:[\w-=&]+(?:<[^>]+>)*[\w-=&]+)?)?)/g;
		const youtubeUrls = original.content.match(regex);
		if (youtubeUrls) {
			original.card.url = youtubeUrls[0];
		}
	}

	await prisma.linkPost.upsert({
		where: {
			linkUrl_postUrl_actorHandle: {
				linkUrl: card.url,
				postUrl: url,
			},
		},
		create: {
			id: uuidv7(),
			post: {
				connectOrCreate: {
					where: {
						url,
					},
					create: {
						id: uuidv7(),
						url,
						text: original.content,
						postDate: original.createdAt,
						postType: PostType.mastodon,
						actor: {
							connectOrCreate: {
								where: {
									handle: original.account.username,
								},
								create: {
									id: uuidv7(),
									name: original.account.displayName,
									handle: original.account.username,
									url: original.account.url,
									avatarUrl: original.account.avatar,
								},
							},
						},
					},
				},
			},
			link: {
				connectOrCreate: {
					where: {
						url: original.card?.url,
					},
					create: {
						id: uuidv7(),
						url: card.url,
						title: card.title,
						description: original.card?.description,
						imageUrl: original.card?.image,
					},
				},
			},
			actor: {
				connectOrCreate: {
					where: {
						handle: t.account.username,
					},
					create: {
						id: uuidv7(),
						handle: t.account.username,
						url: t.account.url,
						name: t.account.displayName,
						avatarUrl: t.account.avatar,
					},
				},
			},
			users: {
				connect: {
					id: userId,
				},
			},
		},
		update: {},
	});
};

export const getLinksFromMastodon = async (userId: string) => {
	const timeline = await getMastodonTimeline(userId);
	const linksOnly = timeline.filter((t) => t.card || t.reblog?.card);
	for await (const t of linksOnly) {
		try {
			await processMastodonLink(userId, t);
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError) {
				if (e.code === "P2002") {
					await processMastodonLink(userId, t);
				}
			}
		}
	}
};

const processBlueskyLink = async (
	userId: string,
	t: AppBskyFeedDefs.FeedViewPost,
) => {
	let record: AppBskyFeedPost.Record | null = null;
	if (AppBskyFeedPost.isRecord(t.post.record)) {
		record = t.post.record;
	}
	if (!record) {
		return null;
	}
	const postUrl = `https://bsky.app/profile/${t.post.author.handle}/post/${t.post.uri.split("/").at(-1)}`;

	// Handle embeds
	let quoted: AppBskyFeedDefs.PostView["embed"] | null = null;
	let quotedRecord: AppBskyEmbedRecord.ViewRecord | null = null;
	let quotedValue: AppBskyFeedPost.Record | null = null;
	let externalRecord: AppBskyEmbedExternal.View | null = null;
	let quotedImageGroup: AppBskyEmbedImages.ViewImage[] = [];
	let detectedLink: BskyDetectedLink | null = null;
	let quotedPostUrl: string | null = null;
	if (AppBskyEmbedRecord.isView(t.post.embed)) {
		quoted = t.post.embed;
		if (AppBskyEmbedRecord.isViewRecord(quoted.record)) {
			quotedRecord = quoted.record;
			quotedPostUrl = `https://bsky.app/profile/${quotedRecord.author.handle}/post/${quotedRecord.uri.split("/").at(-1)}`;
			const embeddedLink = quotedRecord.embeds?.find((e) =>
				AppBskyEmbedExternal.isView(e),
			);
			if (embeddedLink) {
				externalRecord = embeddedLink;
			}
			const imageGroup = quotedRecord?.embeds?.find((embed) =>
				AppBskyEmbedImages.isView(embed),
			);
			if (imageGroup) {
				quotedImageGroup = imageGroup.images;
			}
		}
		if (AppBskyFeedPost.isRecord(quoted.record.value)) {
			quotedValue = quoted.record.value;
			if (!externalRecord) {
				detectedLink = await findBlueskyLinkFacets(quotedValue);
			}
		}
	}

	if (AppBskyEmbedExternal.isView(t.post.embed)) {
		externalRecord = t.post.embed;
	}

	if (!externalRecord) {
		// check for a post with a link but no preview card
		if (!detectedLink) {
			detectedLink = await findBlueskyLinkFacets(record);
		}
	} else {
		detectedLink = {
			uri: externalRecord.external.uri,
			title: externalRecord.external.title,
			description: externalRecord.external.description,
			imageUrl: externalRecord.external.thumb,
		};
	}

	if (!detectedLink) {
		return null;
	}

	// handle image
	let imageGroup: AppBskyEmbedImages.ViewImage[] = [];
	if (AppBskyEmbedImages.isView(t.post.embed)) {
		imageGroup = t.post.embed.images;
	}

	// Do we know about this post?
	const linkPost = await prisma.linkPost.findFirst({
		where: {
			link: {
				url: detectedLink.uri,
			},
			post: {
				url: postUrl,
				repostHandle: AppBskyFeedDefs.isReasonRepost(t.reason)
					? t.reason.by.handle
					: undefined,
			},
		},
	});

	if (linkPost) {
		await prisma.linkPost.update({
			where: {
				id: linkPost.id,
			},
			data: {
				users: {
					connect: { id: userId },
				},
			},
		});

		return null;
	}

	const actors = [
		{
			id: uuidv7(),
			handle: t.post.author.handle,
			url: `https://bsky.app/profile/${t.post.author.handle}`,
			name: t.post.author.displayName,
			avatarUrl: t.post.author.avatar,
		},
	];

	if (quotedRecord) {
		actors.push({
			id: uuidv7(),
			handle: quotedRecord.author.handle,
			url: `https://bsky.app/profile/${quotedRecord.author.handle}`,
			name: quotedRecord.author.displayName,
			avatarUrl: quotedRecord.author.avatar,
		});
	}

	const quotedPost =
		quotedValue && quotedRecord
			? {
					id: uuidv7(),
					url: quotedPostUrl || "",
					text: quotedValue.text,
					postDate: new Date(quotedRecord.indexedAt),
					postType: PostType.bluesky,
					actorHandle: quotedRecord.author.handle,
				}
			: undefined;

	if (AppBskyFeedDefs.isReasonRepost(t.reason)) {
		actors.push({
			id: uuidv7(),
			handle: t.reason.by.handle,
			url: `https://bsky.app/profile/${t.reason.by.handle}`,
			name: t.reason.by.displayName,
			avatarUrl: t.reason.by.avatar,
		});
	}

	const post = {
		id: uuidv7(),
		url: postUrl,
		text: record.text,
		postDate: new Date(t.post.indexedAt),
		postType: PostType.bluesky,
		actorHandle: t.post.author.handle,
		quotingId: quotedPost ? quotedPost.id : undefined,
		repostHandle: AppBskyFeedDefs.isReasonRepost(t.reason)
			? t.reason.by.handle
			: undefined,
	};

	const link = {
		id: uuidv7(),
		url: detectedLink.uri,
		title: detectedLink.title || "",
		description: detectedLink.description,
		imageUrl: detectedLink.imageUrl,
	};

	const newLinkPost = {
		id: uuidv7(),
		linkUrl: link.url,
		postId: post.id,
	};

	return {
		actors,
		quotedPost,
		post,
		link,
		newLinkPost,
	};

	// // Prefetch a ton of stuff so we don't do unnecessary selects below
	// const handlesToFetch = [
	// 	t.post.author.handle,
	// 	quotedRecord?.author.handle || "",
	// 	linkPoster.handle,
	// ].filter(Boolean);

	// const postUrlsToFetch = [postUrl, quotedPostUrl || ""].filter(Boolean);

	// const [existingActors, existingPosts, existingLink] =
	// 	await prisma.$transaction([
	// 		prisma.actor.findMany({ where: { handle: { in: handlesToFetch } } }),
	// 		prisma.post.findMany({ where: { url: { in: postUrlsToFetch } } }),
	// 		prisma.link.findUnique({ where: { url: detectedLink.uri } }),
	// 	]);

	// const actorMap = new Map(
	// 	existingActors.map((actor) => [actor.handle, actor]),
	// );
	// const postMap = new Map(existingPosts.map((post) => [post.url, post]));

	// // Nested quoted post handling
	// let quotedPostData;
	// if (quotedValue && quotedRecord) {
	// 	quotedPostData = postMap.get(quotedPostUrl || "")
	// 		? { connect: { url: quotedPostUrl || "" } }
	// 		: {
	// 				create: {
	// 					id: uuidv7(),
	// 					url: quotedPostUrl || "",
	// 					text: quotedValue.text,
	// 					postDate: new Date(quotedRecord.indexedAt),
	// 					postType: PostType.bluesky,
	// 					images: {
	// 						createMany: {
	// 							data: quotedImageGroup.map((image) => ({
	// 								id: uuidv7(),
	// 								url: image.fullsize,
	// 								alt: image.alt,
	// 							})),
	// 						},
	// 					},
	// 					actor: actorMap.get(quotedRecord.author.handle)
	// 						? {
	// 								connect: { handle: quotedRecord.author.handle },
	// 							}
	// 						: {
	// 								create: {
	// 									id: uuidv7(),
	// 									name: quotedRecord.author.displayName || "",
	// 									handle: quotedRecord.author.handle,
	// 									url: `https://bsky.app/profile/${quotedRecord.author.handle}`,
	// 									avatarUrl: quotedRecord.author.avatar,
	// 								},
	// 							},
	// 				},
	// 			};
	// }

	// const postData = postMap.get(postUrl)
	// 	? { connect: { url: postUrl } }
	// 	: {
	// 			create: {
	// 				id: uuidv7(),
	// 				url: postUrl,
	// 				text: record.text,
	// 				postDate: new Date(t.post.indexedAt),
	// 				postType: PostType.bluesky,
	// 				// Images, quotes, etc.
	// 				images: {
	// 					createMany: {
	// 						data: imageGroup.map((image) => ({
	// 							id: uuidv7(),
	// 							url: image.fullsize,
	// 							alt: image.alt,
	// 						})),
	// 					},
	// 				},
	// 				quoting: quotedPostData,
	// 				actor: actorMap.get(t.post.author.handle)
	// 					? { connect: { handle: t.post.author.handle } }
	// 					: {
	// 							create: {
	// 								id: uuidv7(),
	// 								name: t.post.author.displayName || "",
	// 								handle: t.post.author.handle,
	// 								url: `https://bsky.app/profile/${t.post.author.handle}`,
	// 								avatarUrl: t.post.author.avatar,
	// 							},
	// 						},
	// 			},
	// 		};

	// await prisma.$transaction([
	// 	prisma.linkPost.upsert({
	// 		where: {
	// 			linkUrl_postUrl_actorHandle: {
	// 				linkUrl: detectedLink.uri,
	// 				postUrl: postUrl,
	// 				actorHandle: linkPoster.handle,
	// 			},
	// 		},
	// 		create: {
	// 			id: uuidv7(),
	// 			post: postData,
	// 			link: existingLink
	// 				? { connect: { url: existingLink.url } }
	// 				: {
	// 						create: {
	// 							id: uuidv7(),
	// 							url: detectedLink.uri,
	// 							title: detectedLink.title || "",
	// 							description: detectedLink.description,
	// 							imageUrl: detectedLink.imageUrl,
	// 						},
	// 					},
	// 			actor: actorMap.get(linkPoster.handle)
	// 				? { connect: { handle: linkPoster.handle } }
	// 				: {
	// 						create: {
	// 							id: uuidv7(),
	// 							handle: linkPoster.handle,
	// 							url: `https://bsky.app/profile/${linkPoster.handle}`,
	// 							name: linkPoster.displayName,
	// 							avatarUrl: linkPoster.avatar,
	// 						},
	// 					},
	// 			users: {
	// 				connect: {
	// 					id: userId,
	// 				},
	// 			},
	// 		},
	// 		update: {},
	// 	}),
	// ]);
};

export const getLinksFromBluesky = async (userId: string) => {
	const now = new Date(Date.now());
	const timeline = await getBlueskyTimeline(userId);
	const actors = [];
	const quotedPosts = [];
	const posts = [];
	const links = [];
	const linkPosts = [];
	for await (const t of timeline) {
		const result = await processBlueskyLink(userId, t);
		if (result) {
			actors.push(...result.actors);
			if (result.quotedPost) {
				quotedPosts.push(result.quotedPost);
			}
			posts.push(result.post);
			links.push(result.link);
			linkPosts.push(result.newLinkPost);
		}
	}

	await prisma.actor.createMany({
		data: actors,
		skipDuplicates: true,
	});

	await prisma.post.createMany({
		data: quotedPosts,
		skipDuplicates: true,
	});

	await prisma.$transaction([
		prisma.post.createMany({
			data: posts,
			skipDuplicates: true,
		}),
		prisma.link.createMany({
			data: links,
			skipDuplicates: true,
		}),
	]);
	const createdLinkPosts = await prisma.linkPost.createManyAndReturn({
		data: linkPosts,
		skipDuplicates: true,
	});

	await prisma.user.update({
		where: {
			id: userId,
		},
		data: {
			linkPosts: {
				connect: createdLinkPosts.map((l) => ({ id: l.id })),
			},
		},
	});

	console.log("bluesky processed", timeAgo.format(now, "twitter-now"));
};

const findBlueskyLinkFacets = async (record: AppBskyFeedPost.Record) => {
	let foundLink: BskyDetectedLink | null = null;
	const rt = new RichText({
		text: record.text,
		facets: record.facets,
	});
	for await (const segment of rt.segments()) {
		if (
			segment.link &&
			AppBskyRichtextFacet.validateLink(segment.link).success
		) {
			const existingLink = await prisma.link.findFirst({
				where: {
					url: segment.link.uri,
				},
			});

			// if we already have data
			if (existingLink?.description) {
				return {
					uri: existingLink.url,
					title: existingLink.title,
					imageUrl: existingLink.imageUrl,
					description: existingLink.description,
				};
			}
			await linksQueue.add("fetchMetadata", { uri: segment.link.uri });
			foundLink = {
				uri: segment.link.uri,
				title: "",
				imageUrl: null,
				description: null,
			};
			break;
		}
	}
	return foundLink;
};

export const fetchLinkMetadata = async (uri: string) => {
	const foundLink = await prisma.link.findFirst({
		where: {
			url: uri,
		},
	});

	// if we already have data
	if (foundLink?.description) {
		return;
	}

	try {
		const metadata = await extractFromUrl(uri, {
			timeout: 5000,
		});
		if (metadata) {
			await prisma.link.upsert({
				where: {
					url: uri,
				},
				update: {
					title: metadata["og:title"] || metadata.title,
					description:
						metadata["og:description"] || metadata.description || null,
					imageUrl: metadata["og:image"] || null,
				},
				create: {
					id: uuidv7(),
					url: uri,
					title: metadata["og:title"] || metadata.title,
					description:
						metadata["og:description"] || metadata.description || null,
					imageUrl: metadata["og:image"] || null,
				},
			});
		}
	} catch (e) {
		console.error(`Failed to fetch link ${uri}`, e);
	}
};

interface LinkOccurrenceArgs {
	userId: string;
	time?: number;
	hideReposts?: boolean;
	sort?: string;
	query?: string | undefined;
	fetch?: boolean;
}

export const countLinkOccurrences = async ({
	userId,
	time = ONE_DAY_MS,
	hideReposts = false,
	sort = "popularity",
	query = undefined,
	fetch = false,
}: LinkOccurrenceArgs) => {
	if (fetch) {
		await Promise.all([
			// getLinksFromMastodon(userId),
			getLinksFromBluesky(userId),
		]);
	}

	const mutePhrases = await prisma.mutePhrase.findMany({
		where: {
			userId,
		},
	});

	const mutePhraseSearch = mutePhrases.map((p) => `${p.phrase}`).join(" | ");
	const encodedQuery = query ? query.trim().split(" ").join(" & ") : undefined;

	const searchQuery: Prisma.LinkPostWhereInput[] | undefined = encodedQuery
		? [
				{
					link: {
						description: {
							search: encodedQuery,
							mode: "insensitive",
						},
					},
				},
				{
					link: {
						title: {
							search: encodedQuery,
							mode: "insensitive",
						},
					},
				},
				{
					post: {
						text: {
							search: encodedQuery,
							mode: "insensitive",
						},
					},
				},
				{
					post: {
						quoting: {
							text: {
								search: encodedQuery,
								mode: "insensitive",
							},
						},
					},
				},
			]
		: undefined;

	const start = new Date(Date.now() - time);
	const mostRecentLinkPosts = await prisma.linkPost.findMany({
		where: {
			users: {
				some: {
					id: userId,
				},
			},
			OR: searchQuery,
			NOT: {
				OR: [
					{
						link: {
							description: {
								search: mutePhraseSearch,
								mode: "insensitive",
							},
						},
					},
					{
						link: {
							title: {
								search: mutePhraseSearch,
								mode: "insensitive",
							},
						},
					},
					{
						post: {
							text: {
								search: mutePhraseSearch,
								mode: "insensitive",
							},
						},
					},
					{
						post: {
							quoting: {
								text: {
									search: mutePhraseSearch,
									mode: "insensitive",
								},
							},
						},
					},
					{
						post: {
							actor: {
								name: {
									search: mutePhraseSearch,
									mode: "insensitive",
								},
							},
						},
					},
					{
						post: {
							actor: {
								handle: {
									search: mutePhraseSearch,
									mode: "insensitive",
								},
							},
						},
					},
				],
			},
			post: {
				postDate: {
					gte: start,
				},
			},
		},
		include: {
			link: true,
			post: {
				include: {
					actor: true,
					quoting: {
						include: {
							actor: true,
							images: true,
						},
					},
					images: true,
					reposter: true,
				},
			},
		},
		orderBy: {
			post: {
				postDate: "desc",
			},
		},
	});

	const grouped = groupBy(mostRecentLinkPosts, (l) => {
		return l.link.url;
	});

	if (hideReposts) {
		for (const url in grouped) {
			const group = grouped[url];
			grouped[url] = group.filter((linkPost) => !linkPost.post.reposter);
			if (grouped[url].length === 0) {
				delete grouped[url];
			}
		}
	}

	if (sort === "popularity") {
		const sorted = Object.entries(grouped).sort(
			(a, b) =>
				[
					...new Set(
						b[1].map((l) =>
							l.post.reposter ? l.post.reposter.handle : l.post.actor.handle,
						),
					),
				].length -
				[
					...new Set(
						a[1].map((l) =>
							l.post.reposter ? l.post.reposter.handle : l.post.actor.handle,
						),
					),
				].length,
		);
		return sorted.slice(0, 20);
	}

	return Object.entries(grouped).slice(0, 20);
};
