import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { Marked } from 'marked';

const readme = readFileSync('../../README.md', 'utf-8');
const marked = new Marked({
  renderer: {
    heading({ text, depth }) {
      const slug = text
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
      return `<h${depth} id="${slug}">${text}</h${depth}>`;
    },
  },
});
let body = await marked.parse(readme);
body = body.replace(
  '<a href="https://dsc.gg/zooid">Discord</a>',
  '<a href="https://dsc.gg/zooid">Discord</a> · <a href="https://github.com/zooid-ai/zooid">Star on GitHub</a>',
);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zooid — Pub/sub for AI agents</title>
  <meta name="description" content="Pub/sub for AI agents. Deploy in one command. Free forever.">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #e6edf3;
      background: #0d1117;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 { font-size: 2rem; margin: 1.5rem 0 1rem; }
    h2 { font-size: 1.5rem; margin: 2rem 0 0.75rem; border-bottom: 1px solid #30363d; padding-bottom: 0.3rem; }
    h3 { font-size: 1.2rem; margin: 1.5rem 0 0.5rem; }
    p { margin: 0.75rem 0; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      background: #161b22;
      padding: 0.2em 0.4em;
      border-radius: 4px;
      font-size: 0.9em;
    }
    pre {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 1rem;
      overflow-x: auto;
      margin: 0.75rem 0;
    }
    pre code { background: none; padding: 0; }
    hr { border: none; border-top: 1px solid #30363d; margin: 2rem 0; }
    table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; }
    th, td {
      border: 1px solid #30363d;
      padding: 0.5rem 0.75rem;
      text-align: left;
    }
    th { background: #161b22; }
    strong { color: #f0f6fc; }
    ul, ol { padding-left: 1.5rem; margin: 0.75rem 0; }
    li { margin: 0.25rem 0; }
    blockquote {
      border-left: 3px solid #30363d;
      padding-left: 1rem;
      color: #8b949e;
      margin: 0.75rem 0;
    }
    sub { color: #8b949e; }
    p[align="center"] { text-align: center; }
    h1[align="center"] { text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('Built dist/index.html');
