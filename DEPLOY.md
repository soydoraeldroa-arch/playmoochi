# Smooch Validation Server — Deployment Guide

## Overview
Rate-limited invite code validation server for playsmooch.com. Replaces client-side Firestore validation with server-side rate limiting.

## Architecture
```
Browser → playsmooch.com
  ↓ (smooch-interceptor.js monkey-patches fetch)
User's browser → Validation Server (/api/validate)
  ↓ (rate limited: 5 attempts/IP/hour)
Validation Server → Local codes.json
```

## Quick Deploy (Railway - recommended, free tier)

1. Push `smooch-server/` to a GitHub repo
2. Connect repo to Railway (railway.app)
3. Set environment variables:
   - `PORT=3000` (auto-set by Railway)
   - `ADMIN_SECRET=<your-secret-here>`
4. Deploy — Railway gives you a URL like `https://smooch-server-production-abc123.up.railway.app`

## Alternative Deploy (Render - free tier)

1. Push `smooch-server/` to GitHub
2. Connect to Render (render.com) → New Web Service
3. Build command: `npm install`
4. Start command: `node server.js`
5. Set env vars: `ADMIN_SECRET`, `NODE_ENV=production`

## Alternative Deploy (VPS - $5/mo)

1. `git clone` or `scp` the server to your VPS
2. `npm install --production`
3. `ADMIN_SECRET=your-secret PORT=3000 node server.js &`
4. Set up nginx reverse proxy + SSL (Let's Encrypt)
5. Use systemd to keep it running

## After Deployment

1. Update `smooch-interceptor.js` line 14:
   ```js
   const VALIDATION_SERVER_URL = "https://your-deployed-url.com";
   ```

2. Add to playsmooch.com's `index.html` (before the app bundle):
   ```html
   <script src="/smooch-interceptor.js"></script>
   ```
   Or host it externally and use:
   ```html
   <script src="https://your-cdn.com/smooch-interceptor.js"></script>
   ```

3. Add invite codes via admin API:
   ```bash
   curl -X POST https://your-server.com/api/admin/add \
     -H "Content-Type: application/json" \
     -H "x-admin-secret: your-secret" \
     -d '{"code":"ABCDEFGH","tier":"invited"}'
   ```

## API Reference

### POST /api/validate
Validate an invite code.
```json
// Request
{ "code": "ABCDEFGH" }

// Response (success)
{ "success": true, "tier": "invited", "message": "Welcome! You're in as a invited." }

// Response (rate limited)
{ "success": false, "error": "Too many attempts. Please wait an hour before trying again." }
// HTTP 429
```

### GET /api/health
Health check.
```json
{ "ok": true, "uptime": 123.45, "codes": 5 }
```

### POST /api/admin/add (requires x-admin-secret header)
Add a new invite code.

### POST /api/admin/remove (requires x-admin-secret header)
Remove an invite code.

### GET /api/admin/list (requires x-admin-secret header)
List all invite codes.

## Security Notes

- Rate limiting: 5 failed attempts per IP per hour, 50 global per hour
- Codes are consumed on first use (except "founding" tier)
- Admin routes require `x-admin-secret` header
- CORS is enabled for all origins — restrict in production if needed
- Store `ADMIN_SECRET` securely, never commit to git
