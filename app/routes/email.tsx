import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod";
import { Box, Button, Select, Text } from "@radix-ui/themes";
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	data,
} from "@remix-run/node";
import {
	Form,
	Link,
	json,
	useActionData,
	useLoaderData,
	useSearchParams,
} from "@remix-run/react";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7-js";
import { z } from "zod";
import Layout from "~/components/nav/Layout";
import PageHeading from "~/components/nav/PageHeading";
import { db } from "~/drizzle/db.server";
import { emailSettings } from "~/drizzle/schema.server";
import { requireUserId } from "~/utils/auth.server";

const EmailSettingsSchema = z.object({
	time: z.string(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const userId = await requireUserId(request);
	const currentSettings = await db.query.emailSettings.findFirst({
		where: eq(emailSettings?.userId, userId),
	});

	return data({ currentSettings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
	const userId = await requireUserId(request);
	const formData = await request.formData();
	const submission = await parseWithZod(formData, {
		schema: EmailSettingsSchema,
		async: true,
	});

	if (submission.status !== "success") {
		return data(
			{
				result: submission.reply(),
			},
			{
				status: submission.status === "error" ? 400 : 200,
			},
		);
	}

	await db
		.insert(emailSettings)
		.values({
			id: uuidv7(),
			userId,
			scheduledTime: submission.value.time,
		})
		.onConflictDoUpdate({
			target: [emailSettings.userId],
			set: {
				scheduledTime: submission.value.time,
			},
		});

	return {
		result: submission.reply(),
	};
};

const EmailSettings = () => {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<typeof action>();
	const [searchParams] = useSearchParams();
	const onboarding = searchParams.get("onboarding");

	const [form, fields] = useForm({
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: EmailSettingsSchema });
		},
		shouldValidate: "onBlur",
		shouldRevalidate: "onSubmit",
	});

	const dateFormatter = new Intl.DateTimeFormat("en-US", {
		timeZoneName: "short",
	});

	const dateParts = dateFormatter.formatToParts(new Date());
	const timeZone = dateParts.find(
		(part) => part.type === "timeZoneName",
	)?.value;

	const hours = Array.from({ length: 24 }, (_, i) => {
		const hour = i % 12 || 12;
		const period = i < 12 ? "a.m." : "p.m.";
		return `${hour.toString().padStart(2, "0")}:00 ${period} ${timeZone}`;
	});

	const defaultValue = data.currentSettings?.scheduledTime.substring(0, 5);

	return (
		<Layout hideNav={!!onboarding}>
			<PageHeading
				title="Email Settings"
				dek="Sill can send you a daily email with the top links from the past 24
						hours. Here, you can schedule the hour you'd like to receive the
						email each day."
			/>
			<Form method="POST" {...getFormProps(form)}>
				{actionData?.result?.status === "success" && (
					<Box mb="4">
						<Text as="p">Your email settings have been saved.</Text>
					</Box>
				)}
				<Box>
					<label htmlFor="time">Time</label>
					<br />
					<Select.Root
						{...getInputProps(fields.time, { type: "time" })}
						defaultValue={defaultValue}
					>
						<Select.Trigger placeholder="Select a time" />
						<Select.Content>
							{hours.map((hour, index) => {
								const localDate = new Date();
								localDate.setHours(index, 0, 0, 0);
								const utcHour = localDate.toISOString().substring(11, 16);
								return (
									<Select.Item key={hour} value={utcHour}>
										{hour}
									</Select.Item>
								);
							})}
						</Select.Content>
					</Select.Root>
					<Button type="submit" ml="4">
						Save
					</Button>
				</Box>
			</Form>
			{onboarding && (
				<Box mt="8">
					<Link to="/links">
						<Button>See your top links</Button>
					</Link>
				</Box>
			)}
		</Layout>
	);
};

export default EmailSettings;
