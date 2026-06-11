# claude-recall Landing Page — Deployment Guide

## Overview

The landing page is a single self-contained HTML file (`site/index.html`) with no build step, no dependencies, and no frameworks. It can be deployed to any static hosting provider.

## Files

```
site/
  index.html    — Complete landing page (HTML + CSS + JS, single file)
  DEPLOY.md     — This file
```

## Deployment Options

### Option A: Cloudflare Pages (Recommended)

1. Connect the GitHub repo (`askqai/claude-recall`)
2. Set build output directory to `site/`
3. No build command needed (static files)
4. Set custom domain if desired (e.g., `claude-recall.dev`)

```bash
# Or deploy via Wrangler CLI
npx wrangler pages deploy site/ --project-name=claude-recall
```

### Option B: Vercel

```bash
# From repo root
npx vercel deploy site/ --prod
```

Or via Vercel dashboard:
1. Import the GitHub repo
2. Set root directory to `site/`
3. Framework preset: "Other"
4. No build command

### Option C: GitHub Pages

1. In repo Settings > Pages, set source to "Deploy from a branch"
2. Create a GitHub Actions workflow:

```yaml
# .github/workflows/deploy-pages.yml
name: Deploy Landing Page
on:
  push:
    branches: [main]
    paths: ['site/**']

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/
      - id: deployment
        uses: actions/deploy-pages@v4
```

### Option D: Any Static Host (S3, Nginx, etc.)

Just serve `site/index.html`. No build step required.

```bash
# Quick local test
cd site && python3 -m http.server 8080
```

## Configuration

### License Key API Endpoint

The signup form submits to `/api/license` by default. To configure a different endpoint, set `window.CLAUDE_RECALL_API_URL` before the page loads, or configure the hosting provider to proxy `/api/license` to the actual license key service.

**Cloudflare Pages:** Use a Pages Function or Worker to handle `/api/license`.

**Vercel:** Add a `site/api/license.js` serverless function, or use `vercel.json` rewrites:

```json
{
  "rewrites": [
    { "source": "/api/license", "destination": "https://your-license-api.example.com/api/license" }
  ]
}
```

### Analytics

The page has no analytics by default. To add Plausible:

```html
<script defer data-domain="claude-recall.dev" src="https://plausible.io/js/script.js"></script>
```

Add this to the `<head>` section of `index.html`.

## Updating

The landing page is a single file — edit `site/index.html` and push. No build step, no cache invalidation needed (Cloudflare/Vercel auto-deploy on push).

To update the version badge in the hero section, search for `v11` in the hero-badge div.

## Testing Locally

```bash
cd /path/to/claude-recall/site
python3 -m http.server 8080
# Open http://localhost:8080
```

Or with any static file server (e.g., `npx serve site/`).
