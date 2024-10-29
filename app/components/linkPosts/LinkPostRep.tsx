import { useState } from "react";
import { Avatar, Box, Button } from "@radix-ui/themes";
import groupBy from "object.groupby";
import * as Collapsible from "@radix-ui/react-collapsible";
import type { MostRecentLinkPosts } from "~/utils/links.server";
import LinkRep from "~/components/linkPosts/LinkRep";
import PostRep from "~/components/linkPosts/PostRep";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface LinkPostRepProps {
	linkPost: MostRecentLinkPosts;
}

const LinkPostRep = ({ linkPost }: LinkPostRepProps) => {
	if (!linkPost.posts || !linkPost.link) return null;
	const [open, setOpen] = useState(false);
	const groupedPosts = groupBy(linkPost.posts, (l) => l.post.url);
	const allActors = linkPost.posts.map((p) =>
		p.reposter ? p.reposter.avatarUrl : p.actor.avatarUrl,
	);
	const uniqueActors = [...new Set(allActors)];

	return (
		<Box key={linkPost.link.url}>
			<LinkRep link={linkPost.link} />
			<Collapsible.Root
				className="CollapsibleRoot"
				open={open}
				onOpenChange={setOpen}
			>
				<Collapsible.Trigger asChild>
					<Button variant="soft" size="2">
						{uniqueActors.slice(0, 3).map((actor, i) => (
							<Avatar
								src={actor || undefined}
								alt=""
								loading="lazy"
								decoding="async"
								fallback="T"
								key={actor}
								radius="full"
								size="1"
								style={{
									marginLeft: i > 0 ? "-12px" : "0",
								}}
							/>
						))}
						Shared by {linkPost.uniqueActorsCount}{" "}
						{linkPost.uniqueActorsCount === 1 ? "account" : "accounts"}
						{open ? (
							<ChevronUp width="14" height="14" />
						) : (
							<ChevronDown width="14" height="14" />
						)}
					</Button>
				</Collapsible.Trigger>
				<Collapsible.Content>
					<Box mt="5">
						{Object.entries(groupedPosts).map(([postUrl, group]) => (
							<PostRep
								key={postUrl}
								post={group[0].post}
								group={group}
								actor={group[0].actor}
								quote={group[0].quote}
								image={group[0].image}
							/>
						))}
					</Box>
				</Collapsible.Content>
			</Collapsible.Root>
		</Box>
	);
};

export default LinkPostRep;
