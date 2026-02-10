/**
 * Crawler for lespetitsvendredis.com
 * Extracts all blog posts, images, and comments from the WordPress site.
 * Outputs a JSON file with all post data + downloads all images.
 *
 * Usage: bun scripts/crawl.ts
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type HTMLElement, parse } from "node-html-parser";

const BASE_URL = "https://lespetitsvendredis.com";
const OUTPUT_DIR = "docs";
const IMAGES_DIR = join(OUTPUT_DIR, "images");
const DATA_FILE = "posts_data.json";

const HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LespetitsvendredisCrawler/1.0",
};

const SKIP_SLUGS = new Set([
	"products",
	"activites-du-site",
	"membres",
	"page-d-exemple",
]);

interface Post {
	title: string;
	date: string;
	slug: string;
	url: string;
	content_html: string;
	images: string[];
	comments: { author: string; text: string }[];
	local_images?: (string | null)[];
}

async function fetchText(url: string): Promise<string> {
	const resp = await fetch(url, { headers: HEADERS });
	if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
	return resp.text();
}

async function fetchSitemap(): Promise<string[]> {
	console.log("Fetching sitemap...");
	const xml = await fetchText(`${BASE_URL}/sitemap.xml`);

	const urls: string[] = [];
	// Simple regex XML parsing — no need for a full XML lib for sitemap
	const locRegex = /<loc>(.*?)<\/loc>/g;
	let match = locRegex.exec(xml);
	while (match !== null) {
		urls.push(match[1].trim());
		match = locRegex.exec(xml);
	}
	return urls;
}

function isBlogPostUrl(url: string): boolean {
	const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
	if (!path) return false;
	if (SKIP_SLUGS.has(path)) return false;
	if (path.split("/").length > 1) return false;
	if (url.includes("attachment_id")) return false;
	return true;
}

function extractPost(url: string, html: string): Post | null {
	const root = parse(html);

	// Find post div
	let postDiv = root.querySelector('div[class*="post-"]');
	// Verify it matches post-\d+ pattern
	if (postDiv) {
		const cls = postDiv.getAttribute("class") || "";
		if (!/post-\d+/.test(cls)) postDiv = null;
	}
	if (!postDiv) postDiv = root.querySelector("article");
	if (!postDiv) {
		console.log(`  WARNING: Could not find post content in ${url}`);
		return null;
	}

	// Title
	const titleElem =
		postDiv.querySelector("h1.entry-title") ??
		postDiv.querySelector("h2.entry-title") ??
		root.querySelector("h1.entry-title") ??
		root.querySelector("h2.entry-title");
	const title = titleElem?.text.trim() ?? "";

	// Date
	const dateElem = postDiv.querySelector("span.entry-date");
	const date = dateElem?.text.trim() ?? "";

	// Slug
	const slug = new URL(url).pathname.replace(/^\/|\/$/g, "");

	// Content
	const contentDiv =
		postDiv.querySelector("div.entry-content") ??
		postDiv.querySelector("div.entry-summary");

	let contentHtml = "";
	const images: string[] = [];

	if (contentDiv) {
		// Remove "more-link" anchors
		for (const el of contentDiv.querySelectorAll("a.more-link")) el.remove();

		// Remove AddToAny share buttons
		for (const el of contentDiv.querySelectorAll("div")) {
			const cls = el.getAttribute("class") || "";
			if (/a2a|addtoany|sharedaddy/.test(cls)) el.remove();
		}

		// Collect images
		for (const img of contentDiv.querySelectorAll("img")) {
			const src = img.getAttribute("src") ?? "";
			if (!src) continue;

			let fullSrc: string | null = null;

			// Check parent <a> for full-size image
			const parentA = img.closest("a");
			if (parentA) {
				const href = parentA.getAttribute("href") ?? "";
				if (/\.(jpg|jpeg|png|gif)$/i.test(href)) {
					fullSrc = href;
				}
			}

			if (!fullSrc) {
				// Try srcset
				const srcset = img.getAttribute("srcset") ?? "";
				if (srcset) {
					const parts = srcset.split(",").map((s) => s.trim().split(/\s+/)[0]);
					if (parts.length > 0) fullSrc = parts[0];
				}
			}

			let finalSrc = fullSrc || src;
			if (!finalSrc.startsWith("http")) {
				finalSrc = new URL(finalSrc, BASE_URL).href;
			}
			images.push(finalSrc);
		}

		contentHtml = contentDiv.outerHTML;
	}

	// Comments
	const comments: { author: string; text: string }[] = [];

	const commentList = root.querySelector("ol.commentlist");
	if (commentList) {
		for (const li of commentList.querySelectorAll("li.comment")) {
			// Skip nested replies (children of children)
			if (li.parentNode !== commentList) continue;

			const authorElem =
				li.querySelector("cite.fn") ?? li.querySelector("span.fn");
			const author = authorElem?.text.trim() ?? "Anonyme";

			const bodyElem =
				li.querySelector("div.comment-body") ?? li.querySelector("p");
			if (bodyElem) {
				// Remove author/meta parts
				for (const el of bodyElem.querySelectorAll(
					"cite, div.comment-author, div.comment-meta",
				))
					el.remove();
				const text = bodyElem.text.trim();
				if (text) comments.push({ author, text });
			}
		}
	}

	// Fallback: check #comments div
	if (comments.length === 0) {
		const commentsDiv = root.querySelector("div#comments");
		if (commentsDiv) {
			for (const cd of commentsDiv.querySelectorAll("div.comment")) {
				const authorElem = cd.querySelector('[class*="comment-author"]');
				const author = authorElem?.text.trim() ?? "Anonyme";
				const contentElem = cd.querySelector('[class*="comment-content"]');
				const text = contentElem?.text.trim() ?? "";
				if (text) comments.push({ author, text });
			}
		}
	}

	return {
		title,
		date,
		slug,
		url,
		content_html: contentHtml,
		images,
		comments,
	};
}

function cleanFilename(name: string): string {
	return name.replace(/[^\w\-_.]/g, "_") || "image.jpg";
}

async function downloadImage(imgUrl: string): Promise<string | null> {
	// Normalize
	let url = imgUrl;
	if (url.startsWith("//")) url = "https:" + url;
	else if (!url.startsWith("http")) url = new URL(url, BASE_URL).href;
	url = url.replace("http://", "https://");

	const filename = cleanFilename(basename(new URL(url).pathname));
	const localPath = join(IMAGES_DIR, filename);

	if (existsSync(localPath)) return filename;

	try {
		const resp = await fetch(url, { headers: HEADERS });
		if (!resp.ok) throw new Error(`${resp.status}`);
		const buffer = await resp.arrayBuffer();
		await Bun.write(localPath, buffer);
		console.log(`    Downloaded: ${filename}`);
		return filename;
	} catch (e) {
		console.log(`    ERROR downloading ${url}: ${e}`);
		return null;
	}
}

async function main() {
	mkdirSync(IMAGES_DIR, { recursive: true });

	// 1. Sitemap
	const allUrls = await fetchSitemap();
	console.log(`Found ${allUrls.length} URLs in sitemap`);

	// 2. Filter
	const postUrls = allUrls.filter(isBlogPostUrl);
	console.log(`Filtered to ${postUrls.length} blog post URLs`);

	// 3. Fetch each post
	const posts: Post[] = [];
	for (let i = 0; i < postUrls.length; i++) {
		const url = postUrls[i];
		console.log(`\n[${i + 1}/${postUrls.length}] Processing ${url}`);
		console.log(`  Fetching: ${url}`);
		try {
			const html = await fetchText(url);
			const post = extractPost(url, html);
			if (post) posts.push(post);
		} catch (e) {
			console.log(`  ERROR fetching ${url}: ${e}`);
		}
		// Be nice to the server
		await Bun.sleep(500);
	}

	console.log(`\nSuccessfully extracted ${posts.length} posts`);

	// 4. Download images
	console.log("\nDownloading images...");
	const allImages = new Set<string>();
	for (const post of posts) {
		for (const img of post.images) allImages.add(img);
	}
	allImages.add(
		`${BASE_URL}/wp-content/themes/vintagecustom/images/sylvie.jpg`,
	);

	const imageMap: Record<string, string> = {};
	for (const imgUrl of allImages) {
		const filename = await downloadImage(imgUrl);
		if (filename) imageMap[imgUrl] = filename;
	}

	// 5. Update image references
	for (const post of posts) {
		post.local_images = post.images.map((imgUrl) => {
			const normalized = imgUrl.replace("http://", "https://");
			return imageMap[normalized] ?? imageMap[imgUrl] ?? null;
		});
	}

	// 6. Save JSON
	await Bun.write(
		DATA_FILE,
		JSON.stringify({ posts, image_map: imageMap }, null, 2),
	);

	console.log(`\nData saved to ${DATA_FILE}`);
	console.log(`Images saved to ${IMAGES_DIR}/`);
	console.log(`Total posts: ${posts.length}`);
	console.log(`Total images downloaded: ${Object.keys(imageMap).length}`);

	// Print summary
	console.log("\n--- Post List ---");
	const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date));
	for (const p of sorted) {
		const title = p.title.slice(0, 50).padEnd(50);
		const date = p.date.padEnd(20);
		console.log(
			`  ${date} | ${title} | ${p.images.length} img | ${p.comments.length} comments`,
		);
	}
}

main().catch((e) => {
	console.error("Fatal error:", e);
	process.exit(1);
});
