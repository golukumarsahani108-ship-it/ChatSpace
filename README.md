# ChatSpace — Node.js Complete

A small private realtime 1-to-1 chat app with a blur "spatial glass" look.

## Features
- Google/Gmail sign-in
- Maximum 10 registered users (server enforced)
- Username-based friend discovery and requests
- Email is never shown to friends
- Editable username, display name and profile picture (Settings page)
- 1-to-1 realtime chat with Socket.IO
- Online/offline + last seen, typing indicator
- Sent / delivered / read / opened states
- Text, image and video messages
- **Emoji picker** (with a "recent" tab)
- **One-time (`1×`) messages**: text, photos and videos disappear after the recipient opens them once
- Delete for everyone
- **Settings page**: profile, Space/Daylight theme, glass effect on/off, chat density, message notifications, install app, seats, log out
- **Installable app (PWA)** with its own glass icon — works on Android, desktop Chrome/Edge and iOS (Add to Home Screen)
- Local JSON data store; no Supabase required
- Local uploads for development/small private deployments

## 1. Install
```bat
npm install
```

## 2. Configure Google
Create a Google OAuth Web application in Google Cloud.

Authorized redirect URI for local development (must match EXACTLY):
`http://localhost:3000/auth/google/callback`

Copy `.env.example` to `.env` and fill:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- SESSION_SECRET (any long random string)

Never commit `.env` or put the client secret in `.env.example` / frontend files.

## 3. Start
```bat
npm start
```
Open `http://localhost:3000` (use `localhost`, not `127.0.0.1`).
The terminal prints the exact redirect URI the app expects.

## Installing the app
- **Desktop / Android (Chrome, Edge):** open Settings → *Install app*, or use the install icon in the address bar.
- **iPhone / iPad:** open in Safari → Share → *Add to Home Screen*.
- Installing needs `https://` (or `localhost`). Notifications work while ChatSpace is open in the background.

## Data
`data/store.json` is created automatically. Uploaded media is stored in `uploads/`.

## Important
This local-storage build is intended for a small private ChatSpace. For a public multi-instance production deployment, replace the JSON store, memory sessions and local uploads with a real database/object-storage service, and serve over HTTPS.
