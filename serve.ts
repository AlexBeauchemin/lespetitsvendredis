const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    let path = new URL(req.url).pathname;

    // Default to index.html for directory paths
    if (path.endsWith("/")) path += "index.html";

    const file = Bun.file(`./site${path}`);
    if (await file.exists()) return new Response(file);

    // Try adding /index.html for clean URLs
    const dirFile = Bun.file(`./site${path}/index.html`);
    if (await dirFile.exists()) return new Response(dirFile);

    // 404
    const notFound = Bun.file("./site/404.html");
    return new Response(notFound, { status: 404 });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
