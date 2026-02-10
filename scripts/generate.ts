/**
 * Static site generator for lespetitsvendredis.com
 * Uses Variant C (Fresh & Minimal) design.
 * Reads posts_data.json and generates the full static site.
 *
 * Usage: bun scripts/generate.ts
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "node-html-parser";

const DATA_FILE = "posts_data.json";
const OUTPUT_DIR = "docs";
const IMAGES_DIR = join(OUTPUT_DIR, "images");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Comment {
	author: string;
	text: string;
}

interface Post {
	title: string;
	date: string;
	slug: string;
	url: string;
	content_html: string;
	images: string[];
	comments: Comment[];
	parsedDate?: Date | null;
	parsedDateStr?: string;
}

interface PostData {
	posts: Post[];
	image_map: Record<string, string>;
}

// ---------------------------------------------------------------------------
// French date helpers
// ---------------------------------------------------------------------------

const FRENCH_MONTHS: Record<number, string> = {
	1: "janvier",
	2: "février",
	3: "mars",
	4: "avril",
	5: "mai",
	6: "juin",
	7: "juillet",
	8: "août",
	9: "septembre",
	10: "octobre",
	11: "novembre",
	12: "décembre",
};

const FRENCH_MONTH_TO_NUM: Record<string, number> = {};
for (const [num, name] of Object.entries(FRENCH_MONTHS)) {
	FRENCH_MONTH_TO_NUM[name] = Number(num);
}

function parseFrenchDate(dateStr: string): Date | null {
	if (!dateStr) return null;
	const parts = dateStr.trim().split(/\s+/);
	if (parts.length < 3) return null;
	try {
		const day = parseInt(parts[0], 10);
		const monthStr = parts[1].toLowerCase();
		let month = FRENCH_MONTH_TO_NUM[monthStr] ?? 0;
		if (month === 0) {
			// Fuzzy match
			for (const [name, num] of Object.entries(FRENCH_MONTH_TO_NUM)) {
				if (monthStr.startsWith(name.slice(0, 3))) {
					month = num;
					break;
				}
			}
		}
		const year = parseInt(parts[2], 10);
		if (!day || !month || !year) return null;
		return new Date(year, month - 1, day);
	} catch {
		return null;
	}
}

function formatDate(dt: Date | null): string {
	if (!dt) return "";
	const month = FRENCH_MONTHS[dt.getMonth() + 1] ?? "";
	return `${dt.getDate()} ${month} ${dt.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function getExcerpt(html: string, maxLength = 200): string {
	const root = parse(html);
	let text = root.text.replace(/Continuer la lecture →/g, "").trim();
	if (text.length > maxLength) {
		const cut = text.slice(0, maxLength).lastIndexOf(" ");
		text = text.slice(0, cut > 0 ? cut : maxLength) + "...";
	}
	return text;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

let _attachmentSlugs: Set<string> | null = null;

function loadAttachmentSlugs(): Set<string> {
	if (_attachmentSlugs) return _attachmentSlugs;
	try {
		const raw = require("../attachment_slugs.json") as string[];
		_attachmentSlugs = new Set(raw);
	} catch {
		_attachmentSlugs = new Set();
	}
	return _attachmentSlugs;
}

function isBlogPost(post: Post): boolean {
	return !loadAttachmentSlugs().has(post.slug);
}

// ---------------------------------------------------------------------------
// Image resolution
// ---------------------------------------------------------------------------

function findLocalImage(
	url: string,
	imageMap: Record<string, string>,
): string | null {
	const normalized = url.replace("http://", "https://");

	// Direct match
	if (imageMap[normalized]) return imageMap[normalized];

	// Without size suffix (-300x200)
	const baseUrl = normalized.replace(/-\d+x\d+(\.\w+)$/, "$1");
	if (imageMap[baseUrl]) return imageMap[baseUrl];

	// Match by filename
	const filename = basename(url.split("?")[0]);
	for (const [key, val] of Object.entries(imageMap)) {
		if (basename(key.split("?")[0]) === filename) return val;
	}

	// Check disk for thumbnail filename
	const cleanFilename = filename.replace(/[^\w\-_.]/g, "_");
	if (existsSync(join(IMAGES_DIR, cleanFilename))) return cleanFilename;

	return null;
}

// ---------------------------------------------------------------------------
// Content cleaning
// ---------------------------------------------------------------------------

function cleanContentHtml(
	htmlStr: string,
	imageMap: Record<string, string>,
): string {
	if (!htmlStr) return "";

	let root = parse(htmlStr);
	let wrapper = root.querySelector("div.entry-content");
	if (wrapper) {
		root = parse(wrapper.outerHTML);
		wrapper = root.querySelector("div.entry-content");
	}

	// Remove share buttons
	for (const el of root.querySelectorAll("div, span")) {
		const cls = el.getAttribute("class") ?? "";
		if (/a2a|addtoany|sharedaddy/.test(cls)) el.remove();
	}

	// Remove more-links
	for (const el of root.querySelectorAll("a.more-link")) el.remove();

	// Remove empty paragraphs and divs (no text and no img)
	for (const el of root.querySelectorAll("p, div")) {
		if (!el.text.trim() && !el.querySelector("img")) el.remove();
	}

	// Fix images
	for (const img of root.querySelectorAll("img")) {
		const src = img.getAttribute("src") ?? "";
		if (!src) continue;

		const localFile = findLocalImage(src, imageMap);
		if (localFile) {
			img.setAttribute("src", `/images/${localFile}`);
		} else {
			// Image gone — remove it
			const parentFig = img.closest("figure");
			if (parentFig) {
				parentFig.remove();
			} else {
				const parentA = img.closest("a");
				if (parentA) parentA.remove();
				else img.remove();
			}
			continue;
		}

		// Remove WP-specific attributes
		for (const attr of ["srcset", "sizes", "class", "width", "height"]) {
			img.removeAttribute(attr);
		}

		// Unwrap from parent <a> linking to image
		const parentA = img.closest("a");
		if (parentA) {
			const href = parentA.getAttribute("href") ?? "";
			if (/\.(jpg|jpeg|png|gif)$/i.test(href)) {
				parentA.replaceWith(img);
			}
		}
	}

	// Remove empty figcaptions
	for (const fig of root.querySelectorAll("figure")) {
		const cap = fig.querySelector("figcaption");
		if (cap && !cap.text.trim()) cap.remove();
	}

	// Get inner content
	let innerHtml: string;
	if (wrapper) {
		innerHtml = wrapper.innerHTML;
	} else {
		innerHtml = root.innerHTML;
	}

	// Clean up
	innerHtml = innerHtml
		.replace(/<p>\s*<br\s*\/?>\s*<\/p>/g, "")
		.replace(/<p>\s*<\/p>/g, "")
		.replace(/<div>\s*<br\s*\/?>\s*<\/div>/g, "")
		.replace(/<div>\s*<\/div>/g, "")
		.replace(/\n{3,}/g, "\n\n");

	return innerHtml.trim();
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --color-bg: #fdfbf7;
  --color-text: #2d2d2d;
  --color-text-secondary: #6b6b6b;
  --color-accent: #c4836a;
  --color-accent-soft: #e8d5ce;
  --color-lavender: #9b8fad;
  --color-border: #e8e4df;
}

html {
  background-color: var(--color-bg);
}

body {
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: var(--color-text);
  background: var(--color-bg);
}

a {
  color: var(--color-accent);
  text-decoration: none;
  transition: color 0.2s ease;
}

a:hover {
  color: var(--color-lavender);
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  padding: 16px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.site-title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.site-title a { color: var(--color-text); }
.site-title a:hover { color: var(--color-accent); }

.site-nav { font-size: 14px; }
.site-nav a { color: var(--color-text-secondary); margin-left: 24px; }
.site-nav a:hover { color: var(--color-accent); }

.main-content {
  max-width: 640px;
  margin: 0 auto;
  padding: 60px 24px 80px;
}

.post { margin-bottom: 60px; }
.entry-header { margin-bottom: 40px; }

.entry-title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 42px;
  font-weight: 400;
  line-height: 1.2;
  color: var(--color-text);
  margin-bottom: 16px;
  letter-spacing: -0.02em;
}

.entry-meta {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-secondary);
}

.entry-content {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 19px;
  line-height: 1.85;
  color: var(--color-text);
}

.entry-content p { margin-bottom: 28px; }
.entry-content em { font-style: italic; color: var(--color-text-secondary); }
.entry-content strong { font-weight: 600; }

.entry-content img {
  width: 100%;
  height: auto;
  display: block;
  margin: 40px 0;
  border-radius: 4px;
}

.entry-content figure { margin: 40px 0; }
.entry-content figure img { margin: 0; }

.entry-content figcaption {
  text-align: center;
  font-family: 'DM Sans', sans-serif;
  font-size: 13px;
  color: var(--color-text-secondary);
  margin-top: 10px;
  font-style: italic;
}

.entry-content blockquote {
  border-left: 3px solid var(--color-accent-soft);
  padding-left: 20px;
  margin: 30px 0;
  font-style: italic;
  color: var(--color-text-secondary);
}

.entry-content ul, .entry-content ol { margin: 0 0 28px 24px; }
.entry-content li { margin-bottom: 8px; }

.divider {
  text-align: center;
  margin: 50px 0;
  color: var(--color-accent-soft);
  font-size: 24px;
  letter-spacing: 8px;
}

.author-section {
  border-top: 1px solid var(--color-border);
  padding-top: 40px;
  margin-top: 50px;
  display: flex;
  align-items: flex-start;
  gap: 20px;
}

.author-section img {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  filter: grayscale(20%);
}

.author-info h4 {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}

.author-info p {
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.post-navigation {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-top: 50px;
  padding-top: 30px;
  border-top: 1px solid var(--color-border);
}

.nav-link { display: block; }
.nav-link.next { text-align: right; }

.nav-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}

.nav-title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 16px;
  color: var(--color-text);
  transition: color 0.2s ease;
}

.nav-link:hover .nav-title { color: var(--color-accent); }

.comments-section {
  margin-top: 60px;
  padding-top: 40px;
  border-top: 1px solid var(--color-border);
}

.comments-title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 18px;
  font-weight: 400;
  margin-bottom: 24px;
  color: var(--color-text-secondary);
}

.comment {
  padding: 20px 0;
  border-bottom: 1px solid var(--color-border);
}

.comment:last-child { border-bottom: none; }

.comment-author {
  font-weight: 500;
  color: var(--color-text);
  font-size: 14px;
}

.comment-content {
  margin-top: 8px;
  font-size: 15px;
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.site-footer {
  border-top: 1px solid var(--color-border);
  padding: 40px 24px;
  text-align: center;
  margin-top: 40px;
}

.footer-title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 18px;
  font-weight: 400;
  color: var(--color-text);
  margin-bottom: 8px;
}

.footer-tagline {
  font-size: 13px;
  color: var(--color-text-secondary);
  font-style: italic;
}

.page-header { text-align: center; margin-bottom: 60px; }

.page-header .home-title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 52px;
  font-weight: 400;
  color: var(--color-text);
  margin-bottom: 12px;
  letter-spacing: -0.02em;
}

.page-header .home-tagline {
  font-size: 16px;
  color: var(--color-text-secondary);
  font-style: italic;
  margin-bottom: 20px;
}

.page-header .home-author {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}

.page-header .home-author img {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  filter: grayscale(20%);
}

.page-header .home-author span {
  font-size: 15px;
  color: var(--color-text-secondary);
}

.post-list { list-style: none; padding: 0; }

.post-list-item {
  border-bottom: 1px solid var(--color-border);
  padding: 28px 0;
}

.post-list-item:first-child { border-top: 1px solid var(--color-border); }
.post-list-item a { display: block; color: inherit; }
.post-list-item a:hover .post-list-title { color: var(--color-accent); }

.post-list-date {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-secondary);
  margin-bottom: 6px;
}

.post-list-title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 24px;
  font-weight: 400;
  line-height: 1.3;
  color: var(--color-text);
  margin-bottom: 8px;
  transition: color 0.2s ease;
  letter-spacing: -0.01em;
}

.post-list-excerpt {
  font-size: 15px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

@media (max-width: 600px) {
  .site-header { flex-direction: column; gap: 10px; text-align: center; }
  .site-nav a { margin: 0 12px; }
  .main-content { padding: 40px 20px 60px; }
  .entry-title { font-size: 32px; }
  .entry-content { font-size: 17px; }
  .post-navigation { grid-template-columns: 1fr; }
  .nav-link.next { text-align: left; }
  .author-section { flex-direction: column; align-items: center; text-align: center; }
  .page-header .home-title { font-size: 36px; }
  .post-list-title { font-size: 20px; }
}
`;

// ---------------------------------------------------------------------------
// HTML template helpers
// ---------------------------------------------------------------------------

function htmlHead(title: string, description = ""): string {
	const desc =
		description ||
		"Les petites histoires farfelues du vendredi de Sylvie Lafleur";
	return `<!DOCTYPE html>
<html lang="fr-FR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Les petits vendredis">
<meta name="robots" content="noai, noimageai">
<meta name="robots" content="max-snippet:-1, max-image-preview:large, max-video-preview:-1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>`;
}

const HEADER = `<header class="site-header">
  <h1 class="site-title"><a href="/">Les petits vendredis</a></h1>
  <nav class="site-nav">
    <a href="/">Accueil</a>
  </nav>
</header>`;

const FOOTER = `<footer class="site-footer">
  <div class="footer-title">Les petits vendredis</div>
  <p class="footer-tagline">Les petites histoires farfelues du vendredi de Sylvie Lafleur</p>
</footer>`;

// ---------------------------------------------------------------------------
// Page generators
// ---------------------------------------------------------------------------

function generatePostPage(
	post: Post,
	prevPost: Post | null,
	nextPost: Post | null,
	imageMap: Record<string, string>,
): string {
	const title = post.title;
	const dateStr = post.parsedDateStr ?? post.date;
	const content = cleanContentHtml(post.content_html, imageMap);
	const comments = post.comments ?? [];
	const excerpt = getExcerpt(post.content_html, 160);

	// Navigation
	let navHtml = "";
	if (prevPost || nextPost) {
		navHtml = '<nav class="post-navigation">\n';
		if (prevPost) {
			navHtml += `    <a href="/${prevPost.slug}/" class="nav-link prev">\n`;
			navHtml += `      <div class="nav-label">Précédent</div>\n`;
			navHtml += `      <div class="nav-title">${escapeHtml(prevPost.title)}</div>\n`;
			navHtml += `    </a>\n`;
		} else {
			navHtml += "    <div></div>\n";
		}
		if (nextPost) {
			navHtml += `    <a href="/${nextPost.slug}/" class="nav-link next">\n`;
			navHtml += `      <div class="nav-label">Suivant</div>\n`;
			navHtml += `      <div class="nav-title">${escapeHtml(nextPost.title)}</div>\n`;
			navHtml += `    </a>\n`;
		} else {
			navHtml += "    <div></div>\n";
		}
		navHtml += "  </nav>";
	}

	// Comments
	let commentsHtml = "";
	if (comments.length > 0) {
		const n = comments.length;
		const label = n === 1 ? "commentaire" : "commentaires";
		commentsHtml = `<section class="comments-section">\n`;
		commentsHtml += `    <h3 class="comments-title">${n} ${label}</h3>\n`;
		for (const c of comments) {
			commentsHtml += `    <div class="comment">\n`;
			commentsHtml += `      <div class="comment-author">${escapeHtml(c.author)}</div>\n`;
			commentsHtml += `      <div class="comment-content">${escapeHtml(c.text)}</div>\n`;
			commentsHtml += `    </div>\n`;
		}
		commentsHtml += "  </section>";
	}

	return `${htmlHead(`${title} | Les petits vendredis`, excerpt)}
<body>

${HEADER}

<main class="main-content">
  <article class="post">
    <header class="entry-header">
      <h1 class="entry-title">${escapeHtml(title)}</h1>
      <div class="entry-meta">${escapeHtml(dateStr)}</div>
    </header>

    <div class="entry-content">
      ${content}
    </div>
  </article>

  <div class="divider">&middot;&middot;&middot;</div>

  <section class="author-section">
    <img src="/images/sylvie.jpg" alt="Sylvie Lafleur">
    <div class="author-info">
      <h4>Sylvie Lafleur</h4>
      <p>Femme ordinaire, mère qui s'est bien tirée d'affaire, folle à temps partiel ayant un esprit très frivole et des idées plus farfelues les unes que les autres.</p>
    </div>
  </section>

  ${navHtml}

  ${commentsHtml}
</main>

${FOOTER}

</body>
</html>`;
}

function generateHomepage(posts: Post[]): string {
	let postItems = "";
	for (const p of posts) {
		const dateStr = p.parsedDateStr ?? p.date;
		const excerpt = getExcerpt(p.content_html, 180);
		postItems += `    <li class="post-list-item">
      <a href="/${p.slug}/">
        <div class="post-list-date">${escapeHtml(dateStr)}</div>
        <h2 class="post-list-title">${escapeHtml(p.title)}</h2>
        <p class="post-list-excerpt">${escapeHtml(excerpt)}</p>
      </a>
    </li>\n`;
	}

	return `${htmlHead("Les petits vendredis", "Voici les petites histoires farfelues du vendredi de Sylvie Lafleur")}
<body>

${HEADER}

<main class="main-content">
  <div class="page-header">
    <h1 class="home-title">Les petits vendredis</h1>
    <p class="home-tagline">Voici mes petites histoires du vendredi, plus farfelues les unes que les autres</p>
    <div class="home-author">
      <img src="/images/sylvie.jpg" alt="Sylvie Lafleur">
      <span>Par Sylvie Lafleur</span>
    </div>
  </div>

  <ul class="post-list">
${postItems}  </ul>
</main>

${FOOTER}

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const data: PostData = await Bun.file(DATA_FILE).json();
	const allPosts = data.posts;
	const imageMap = data.image_map;

	// Filter
	const posts = allPosts.filter(isBlogPost);
	console.log(
		`Processing ${posts.length} blog posts (filtered from ${allPosts.length} total)`,
	);

	// Parse and sort by date (newest first)
	for (const p of posts) {
		const dt = parseFrenchDate(p.date);
		p.parsedDate = dt;
		p.parsedDateStr = dt ? formatDate(dt) : p.date;
	}
	posts.sort(
		(a, b) => (b.parsedDate?.getTime() ?? 0) - (a.parsedDate?.getTime() ?? 0),
	);

	// CSS
	const cssPath = join(OUTPUT_DIR, "style.css");
	await Bun.write(cssPath, CSS);
	console.log(`Generated: ${cssPath}`);

	// Individual post pages
	for (let i = 0; i < posts.length; i++) {
		const post = posts[i];
		const prevPost = i + 1 < posts.length ? posts[i + 1] : null;
		const nextPost = i > 0 ? posts[i - 1] : null;

		const postDir = join(OUTPUT_DIR, post.slug);
		mkdirSync(postDir, { recursive: true });

		const html = generatePostPage(post, prevPost, nextPost, imageMap);
		const filepath = join(postDir, "index.html");
		await Bun.write(filepath, html);
		console.log(`  [${i + 1}/${posts.length}] Generated: /${post.slug}/`);
	}

	// Homepage
	const homepageHtml = generateHomepage(posts);
	const homepagePath = join(OUTPUT_DIR, "index.html");
	await Bun.write(homepagePath, homepageHtml);
	console.log(`\nGenerated: ${homepagePath}`);

	// CNAME
	await Bun.write(join(OUTPUT_DIR, "CNAME"), "lespetitsvendredis.com\n");
	console.log(`Generated: ${join(OUTPUT_DIR, "CNAME")}`);

	// .nojekyll
	await Bun.write(join(OUTPUT_DIR, ".nojekyll"), "");
	console.log(`Generated: ${join(OUTPUT_DIR, ".nojekyll")}`);

	// 404
	const notFoundHtml = `${htmlHead("Page introuvable | Les petits vendredis")}
<body>

${HEADER}

<main class="main-content">
  <div class="page-header" style="margin-top: 60px;">
    <h1 class="home-title">Page introuvable</h1>
    <p class="home-tagline">Cette page n'existe pas ou a été déplacée.</p>
    <p style="margin-top: 30px;"><a href="/">Retour à l'accueil</a></p>
  </div>
</main>

${FOOTER}

</body>
</html>`;
	await Bun.write(join(OUTPUT_DIR, "404.html"), notFoundHtml);
	console.log(`Generated: ${join(OUTPUT_DIR, "404.html")}`);

	// Sitemap
	let sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n';
	sitemap += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
	sitemap += "  <url>\n";
	sitemap += "    <loc>https://lespetitsvendredis.com/</loc>\n";
	sitemap += "    <priority>1.0</priority>\n";
	sitemap += "  </url>\n";
	for (const p of posts) {
		const dt = p.parsedDate;
		const lastmod = dt
			? `\n    <lastmod>${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}</lastmod>`
			: "";
		sitemap += `  <url>\n`;
		sitemap += `    <loc>https://lespetitsvendredis.com/${p.slug}/</loc>${lastmod}\n`;
		sitemap += `  </url>\n`;
	}
	sitemap += "</urlset>\n";
	await Bun.write(join(OUTPUT_DIR, "sitemap.xml"), sitemap);
	console.log(`Generated: ${join(OUTPUT_DIR, "sitemap.xml")}`);

	// robots.txt — skip if exists (managed manually)
	const robotsPath = join(OUTPUT_DIR, "robots.txt");
	if (!existsSync(robotsPath)) {
		await Bun.write(
			robotsPath,
			"User-agent: *\nAllow: /\n\nSitemap: https://lespetitsvendredis.com/sitemap.xml\n",
		);
		console.log(`Generated: ${robotsPath}`);
	} else {
		console.log(`Skipped: ${robotsPath} (already exists, managed manually)`);
	}

	console.log(`\n=== Site generation complete ===`);
	console.log(`Output directory: ${OUTPUT_DIR}/`);
	console.log(
		`Total pages: ${posts.length + 2} (homepage + ${posts.length} posts + 404)`,
	);
}

main().catch((e) => {
	console.error("Fatal error:", e);
	process.exit(1);
});
