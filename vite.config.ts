/// <reference types="vitest" />
import { reactRouter } from "@react-router/dev/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "@remix-run/node" {
	interface Future {
		v3_singleFetch: true;
	}
}

export default defineConfig({
	build: {
		target: "esnext",
	},
	plugins: [
		!process.env.VITEST
			? reactRouter({
					future: {
						v3_fetcherPersist: true,
						v3_relativeSplatPath: true,
						v3_throwAbortReason: true,
						v3_singleFetch: true,
						v3_lazyRouteDiscovery: true,
						v3_routeConfig: true,
					},
				})
			: react(),
		tsconfigPaths(),
	],
	server: {
		port: 3000,
	},
	ssr: {
		target: "node",
		noExternal: [/react-tweet.*/],
	},
	test: {
		environment: "happy-dom",
		// Additionally, this is to load ".env.test" during vitest
		env: loadEnv("test", process.cwd(), ""),
	},
});
